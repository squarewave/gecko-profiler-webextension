function adjustState(newState) {
  Object.assign(window.profilerState, newState);
  browser.storage.local.set({profilerState: window.profilerState});
}

async function startProfiler() {
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
                               threads);
}

async function primeSymbolStore() {
  const sli = await browser.profiler.getSharedLibraryInformation();
  return await symbolStore.prime(sli);
}

function makeProfileAvailableToTab(profile, port) {
  port.postMessage({ type: 'ProfilerConnectToPage', payload: profile });
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

async function captureProfile() {
  // Pause profiler before we collect the profile, so that we don't capture
  // more samples while the parent process waits for subprocess profiles.
  await browser.profiler.pause().catch(() => {});

  const profilePromise = browser.profiler.getProfile().catch(e => (console.error(e), {}));
  const tabOpenPromise = createAndWaitForTab(window.profilerState.reportUrl);
  const symbolStorePrimingPromise = Promise.resolve(true); //primeSymbolStore();

  try {
    const [profile, { port }] = await Promise.all([profilePromise, tabOpenPromise, symbolStorePrimingPromise]);
    makeProfileAvailableToTab(profile, port);
  } catch (e) {
    console.log("error getting profile:");
    console.error(e);
    const { tab } = await tabOpenPromise;
    await browser.tabs.update(tab.id, { url: `data:text/html,${e}` });
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

async function stopProfiler() {
  await browser.profiler.stop();
}

async function restartProfiler() {
  await stopProfiler();
  await startProfiler();
}

(async () => {
  window.profilerState = (await browser.storage.local.get('profilerState')).profilerState;

  adjustState({ isRunning: false });
  browser.profiler.onRunningChanged.addListener(isRunning => {
    adjustState({ isRunning });
    browser.browserAction.setIcon({ path: `icons/toolbar_${isRunning ? 'on' : 'off' }.png` });
    for (const popup of browser.extension.getViews({ type: 'popup' })) {
      popup.renderState(browser.profilerState);
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
})();

