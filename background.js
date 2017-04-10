function adjustState(newState) {
  Object.assign(window.profilerState, newState);
  browser.storage.local.set({profilerState: window.profilerState});
}

function makeProfileAvailableToTab(profile, port) {
  port.postMessage({ type: 'ProfilerConnectToPage', payload: profile });

  port.onMessage.addListener(async message => {
    if (message.type === 'ProfilerGetSymbolTable') {
      const { debugName, breakpadId } = message;
      console.log(`requested ${debugName} ${breakpadId}`)
      try {
        const [ addresses, index, buffer ] = await browser.profiler.getSymbols(debugName, breakpadId);

        port.postMessage({
          type: 'ProfilerGetSymbolTableReply',
          status: 'success',
          result: [addresses, index, buffer],
          debugName, breakpadId
        });
      } catch (e) {
        port.postMessage({
          type: 'ProfilerGetSymbolTableReply',
          status: 'error',
          error: `${e}`,
          debugName, breakpadId
        });
      }
    }
  });
}

async function createAndWaitForTab(url) {
  const listenForConnectPromise = listenOnceForConnect('ProfilerPage');

  const tabPromise = browser.tabs.create({
    active: true,
    url: window.profilerState.reportUrl,
  });

  const tab = await tabPromise;
  const port = await listenForConnectPromise;
  return { tab, port };
}

async function listenOnceForConnect(name) {
  window.connectDeferred[name] = {};
  window.connectDeferred[name].promise = new Promise((resolve, reject) =>  {
    Object.assign(window.connectDeferred[name], { resolve, reject });
  });
  return await window.connectDeferred[name].promise;
}

async function captureProfile(panelID = null) {
  // Pause profiler before we collect the profile, so that we don't capture
  // more samples while the parent process waits for subprocess profiles.
  await browser.profiler.pause(panelID).catch(() => {});

  const profilePromise = browser.profiler.getProfile(panelID).catch(e => (console.error(e), {}));
  const tabOpenPromise = createAndWaitForTab(window.profilerState.reportUrl);
  const symbolStorePrimingPromise = browser.profiler.primeSymbolStore(panelID);

  try {
    const [profile, { port }] = await Promise.all([profilePromise, tabOpenPromise, symbolStorePrimingPromise]);
    makeProfileAvailableToTab(profile, port);
  } catch (e) {
    console.log("error getting profile:");
    console.error(e);
    const { tab } = await tabOpenPromise;
    // TODO data URL doesn't seem to be working. Permissions issue?
    // await browser.tabs.update(tab.id, { url: `data:text/html,${encodeURIComponent(e.toString)}` });
  }

  try {
    await browser.profiler.resume();
  } catch (e) {
    console.error(e);
  }
}

window.connectDeferred = {};
browser.runtime.onConnect.addListener(port => {
  if (window.connectDeferred[port.name]) {
    window.connectDeferred[port.name].resolve(port);
  }
});

async function startProfiler(panelID = null) {
  const settings = window.profilerState;
  const threads = settings.threads.split(",");
  const enabledFeatures = Object.keys(settings.features).filter(f => settings.features[f]);
  enabledFeatures.push("leaf");
  if (threads.length > 0) {
    enabledFeatures.push("threads");
  }
  await browser.profiler.start(settings.buffersize,
                               settings.interval,
                               enabledFeatures,
                               threads,
                               panelID);
}

async function stopProfiler(panelID = null) {
  await browser.profiler.stop(panelID);
}

async function restartProfiler(panelID = null) {
  await stopProfiler(panelID);
  await startProfiler(panelID);
}

(async () => {
  window.profilerState = (await browser.storage.local.get('profilerState')).profilerState;

  browser.profiler.onRunningChanged.addListener(isRunning => {
    adjustState({ isRunning });
    browser.browserAction.setIcon({ path: `icons/toolbar_${isRunning ? 'on' : 'off' }.png` });
    for (const popup of browser.extension.getViews({ type: 'popup' })) {
      popup.renderState(window.profilerState);
    }
  });

  browser.profiler.registerDevtoolsPanel("gecko-profiler-addon", {
    icon: "icons/toolbar_off.png",
    url: "panel.html",
    label: "Gecko Profiler",
    tooltip: "This panel is provided by the Gecko Profiler add-on."
  });

  browser.profiler.onDevtoolsPanelMessage.addListener(async (message, panelID, sendResponse) => {
    switch (message.type) {
      case 'PanelConnected':
        const state = Object.assign({}, window.profilerState);
        state.isRunning = await browser.profiler.isRunning(panelID);
        browser.profiler.sendDevtoolsPanelMessage(panelID, { type: 'ProfilerStateUpdated', state });
        break;
      case 'ProfilerControlStartProfiler':
        startProfiler(panelID);
        browser.profiler.sendDevtoolsPanelMessage(panelID, {
          type: 'ProfilerStateUpdated',
          state: { isRunning: true}
        });
        break;
      case 'ProfilerControlStopProfiler':
        stopProfiler(panelID);
        browser.profiler.sendDevtoolsPanelMessage(panelID, {
          type: 'ProfilerStateUpdated',
          state: { isRunning: false}
        });
        break;
      case 'ProfilerControlCaptureProfile':
        captureProfile(panelID);
        break;
      case 'ProfilerControlChangeSetting':
        break;
      case 'ProfilerControlChangeFeature':
        break;
    }
  });

  browser.commands.onCommand.addListener(command => {
    if (command === 'ToggleProfiler') {
      if (window.profilerState.isRunning) {
        stopProfiler();
      } else {
        startProfiler();
      }
    } else if (command === 'CaptureProfile') {
      if (window.profilerState.isRunning) {
        captureProfile();
      }
    }
  });

  if (!window.profilerState) {
    window.profilerState = {};
    adjustState({
      isRunning: false,
      settingsOpen: false,
      buffersize: 1000000,
      interval: 1,
      features: {
        js: true,
        stackwalk: true,
        tasktracer: false,
      },
      threads: 'GeckoMain,Compositor',
      reportUrl: 'https://perf-html.io/from-addon/',
    });
  }

  if (window.profilerState.isRunning) {
    startProfiler();
  } else {
    stopProfiler();
  }
})();

