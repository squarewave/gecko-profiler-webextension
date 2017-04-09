const { utils: Cu, classes: Cc, interfaces: Ci } = Components;

Cu.import("resource://gre/modules/ExtensionUtils.jsm");
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/Subprocess.jsm");
Cu.import("resource://gre/modules/Timer.jsm");
const { OS } = Cu.import("resource://gre/modules/osfile.jsm", {});
const { gDevTools } = Cu.import("resource://devtools/client/framework/gDevTools.jsm", {});
const { loader } = Cu.import("resource://devtools/shared/Loader.jsm", {});
Cu.importGlobalProperties(['fetch', 'Blob', 'TextDecoder', 'TextEncoder', 'URL']);

loader.lazyRequireGetter(this, "EventEmitter", "devtools/shared/event-emitter");

const kAsyncStackPrefName = "javascript.options.asyncstack";
let gAsyncStacksWereEnabled = false;

const {
  SingletonEventManager
} = ExtensionUtils;

function extensionURL(relativePath) {
  return `resource://extension-profiler-api/${relativePath}`;
}

Cu.import(extensionURL("Worker.jsm"));

function parseSym(data) {
  const worker =  new Worker(extensionURL('parse-syms-worker.js'));
  worker.postMessage(data);
  return new Promise((resolve, reject) => {
    worker.onmessage = (e) => {
      if (e.data.error) {
        reject(e.data.error);
      } else {
        resolve(e.data.result);
      }
    }
  });
}

function dumpSyms(path, platform, arch) {
  let filename = path.substr(path.lastIndexOf("/") + 1);
  if (platform != 'darwin' && platform != 'linux')
    platform = filename.match(/\.so(\.[0-9]+)?$/) ? 'linux' : 'darwin';
  return new Promise(function (resolve, reject) {
    let worker = new ChromeWorker(extensionURL("dump-syms-worker.js"));
    worker.onmessage = function (e) {
      if (e.data && ('type' in e.data)) {
        switch (e.data.type) {
          case "error":
            reject(e.data.error);
            break;
          case "success":
            resolve(e.data.result);
            break;
          case "printErr":
            console.log(e.data.text);
            break;
        }
      }
    }
    let scriptURL = extensionURL(`dump_syms-${platform}.js`);
    worker.postMessage({
      type: "request",
      filename, path, platform, arch, scriptURL
    });
  });
}

function getArch() {
  let abi = Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime).XPCOMABI;
  if (abi == 'x86_64-gcc3') {
    return 'x86_64';
  }
  return abi;
}

function getPlatform() {
  return Cc["@mozilla.org/xre/app-info;1"].getService(Ci.nsIXULRuntime).OS;
}

function profiler() {
  if (!profiler.cachedProfiler) {
    profiler.cachedProfiler = Cc["@mozilla.org/tools/profiler;1"].getService(Ci.nsIProfiler);
  }
  return profiler.cachedProfiler;
}

class NMParser {
  constructor() {
    this._addrToSymMap = new Map();
    this._currentLine = '';
    this._approximateSymLength = 0;
  }

  consume(data) {
    const currentLineLength = this._currentLine.length;
    let buffer = this._currentLine + data;
    let nextLineBreak = buffer.indexOf('\n', currentLineLength);
    while (nextLineBreak !== -1) {
      this._processLine(buffer.substr(0, nextLineBreak));
      buffer = buffer.substr(nextLineBreak + 1);
      nextLineBreak = buffer.indexOf('\n');
    }
    this._currentLine = buffer;
  }

  finish() {
    this._processLine(this._currentLine);
    return {
      syms: this._addrToSymMap,
      approximateSymLength: this._approximateSymLength,
    };
  }

  _processLine(line) {
    // Example lines:
    // 00000000028c9888 t GrFragmentProcessor::MulOutputByInputUnpremulColor(sk_sp<GrFragmentProcessor>)::PremulFragmentProcessor::onCreateGLSLInstance() const::GLFP::~GLFP()
    // 00000000028c9874 t GrFragmentProcessor::MulOutputByInputUnpremulColor(sk_sp<GrFragmentProcessor>)::PremulFragmentProcessor::onCreateGLSLInstance() const::GLFP::~GLFP()
    // 00000000028c9874 t GrFragmentProcessor::MulOutputByInputUnpremulColor(sk_sp<GrFragmentProcessor>)::PremulFragmentProcessor::onCreateGLSLInstance() const::GLFP::~GLFP()
    // 0000000003a33730 r mozilla::OggDemuxer::~OggDemuxer()::{lambda()#1}::operator()() const::__func__
    // 0000000003a33930 r mozilla::VPXDecoder::Drain()::{lambda()#1}::operator()() const::__func__
    //
    // Some lines have the form
    // <address> ' ' <letter> ' ' <symbol>
    // and some have the form
    // <address> ' ' <symbol>
    // The letter has a meaning, but we ignore it.

    const firstSpace = line.indexOf(' ');
    if (firstSpace === -1) {
      return;
    }

    const addressString = line.substr(0, firstSpace);
    const symbolStart = line.charAt(firstSpace + 2) === ' ' ? firstSpace + 3 : firstSpace + 1;
    const symbolString = line.substr(symbolStart).trim();
    const address = parseInt(addressString, 16);
    this._addrToSymMap.set(address, symbolString);
    this._approximateSymLength += symbolString.length;
  }
}

// The following two functions below are copied from parse-sym-worker.js.
// I don't know how to easily share code between SDK-style modules and workers.
function convertStringArrayToUint8BufferWithIndex(array, approximateLength) {
  const index = new Uint32Array(array.length + 1);

  const textEncoder = new TextEncoder();
  let buffer = new Uint8Array(approximateLength);
  let pos = 0;

  for (let i = 0; i < array.length; i++) {
    const encodedString = textEncoder.encode(array[i]);
    while (pos + encodedString.length > buffer.length) {
      let newBuffer = new Uint8Array(buffer.length << 1);
      newBuffer.set(buffer);
      buffer = newBuffer;
    }
    buffer.set(encodedString, pos);
    index[i] = pos;
    pos += encodedString.length;
  }
  index[array.length] = pos;

  return { index, buffer };
}

function convertSymsMapToExpectedSymFormat(syms, approximateSymLength) {
  const addresses = Array.from(syms.keys());
  addresses.sort((a, b) => a - b);

  const symsArray = addresses.map(addr => syms.get(addr));
  const { index, buffer } =
    convertStringArrayToUint8BufferWithIndex(symsArray, approximateSymLength);

  return [new Uint32Array(addresses), index, buffer];
}

function feedProcessStdoutInto(proc, consumer) {
  return new Promise((resolve, reject) => {
    proc.stdout.on('data', data => consumer.consume(data));
    proc.on('close', exitCode => {
      if (exitCode == 0) {
        resolve(consumer);
      } else {
        reject(`exit code ${exitCode}`);
      }
    });
    proc.on('error', reject);
  });
}

async function readAllData(pipe, processData) {
  let data;
  while (data = await pipe.readString()) {
    processData(data);
  }
}

async function spawnProcess(name, cmdArgs, processData) {
  const opts = {};
  opts.command = await Subprocess.pathSearch(name);
  opts.arguments = cmdArgs;
  opts.environment = {};
  const proc = await Subprocess.call(opts);

  await readAllData(proc.stdout, processData);
}

async function getSymbolsFromNM(path) {
  const parser = new NMParser();
  await spawnProcess('nm', ['--demangle', path], data => parser.consume(data));
  await spawnProcess('nm', ['-D', '--demangle', path], data => parser.consume(data));
  const { syms, approximateSymLength } = parser.finish();
  return convertSymsMapToExpectedSymFormat(syms, approximateSymLength);
}

async function startProfiler(entries, interval, features, threads) {
  await new Promise((resolve, reject) => {
    gAsyncStacksWereEnabled = Services.prefs.getBoolPref(kAsyncStackPrefName, false);
    Services.prefs.setBoolPref(kAsyncStackPrefName, false);
    if (threads.length) {
      try {
        profiler().StartProfiler(entries, interval, features, features.length, threads, threads.length);
        resolve();
        return;
      } catch (e) {
      }
    }
    profiler().StartProfiler(entries, interval, features, features.length);
    resolve();
  });
}

async function stopProfiler(remotePanelId) {
  await new Promise((resolve, reject) => {
    Services.prefs.setBoolPref(kAsyncStackPrefName, gAsyncStacksWereEnabled);
    profiler().StopProfiler();
    resolve();
  });
}

async function pauseProfiler(remotePanelId) {
  profiler().PauseSampling();
  return Promise.resolve();
}

async function resumeProfiler(remotePanelId) {
  profiler().ResumeSampling();
  return Promise.resolve();
}

function isRunning(remotePanelId) {
  return Promise.resolve(profiler().IsActive());
}

function getProfile(remotePanelId) {
  if (!profiler().IsActive()) {
    return Promise.reject(new Error("The profiler is stopped. " +
      "You need to start the profiler before you can capture a profile."));
  }
  if (profiler().getProfileDataAsync) {
    return profiler().getProfileDataAsync();
  }
  // No luck - synchronous it is.
  return Promise.resolve(profiler().getProfileData());
}

function getSharedLibraryInformation() {
  if ('sharedLibraries' in profiler()) {
    return Promise.resolve(profiler().sharedLibraries);
  }

  // If profiler().sharedLibraries does not exist, then we're in a
  // pre-bug 1329111 build and need to massage the data a little so that it
  // has the shape that we need.

  // Sanity check
  if (!('getSharedLibraryInformation' in profiler())) {
    return Promise.reject(new Error('Cannot find shared library information'));
  }

  const sli = profiler().getSharedLibraryInformation();
  let json = JSON.parse(sli);
  return Promise.resolve(json.map(lib => {
    let debugName, breakpadId;
    if ('breakpadId' in lib) {
      debugName = lib.name.substr(lib.name.lastIndexOf("/") + 1);
      breakpadId = lib.breakpadId;
    } else {
      debugName = lib.pdbName;
      let pdbSig = lib.pdbSignature.replace(/[{}-]/g, "").toUpperCase();
      breakpadId = pdbSig + lib.pdbAge;
    }
    // Before bug 1329111, the path was in the 'name' property on macOS and
    // Linux, and unobtainable on Windows.
    const path = lib.path || lib.name;
    const arch = lib.arch || getArch();
    return Object.assign({}, lib, { debugName, breakpadId, path, arch });
  }));
}

function pathComponentsForSymbolFile(debugName, breakpadId) {
  let symName = debugName;
  if (debugName.endsWith('.pdb')) {
    symName = debugName.substr(0, debugName.length - 4);
  }
  return [debugName, breakpadId, symName + '.sym'];
}

function urlForSymFile(debugName, breakpadId) {
  return 'http://symbols.mozilla.org/' +
    pathComponentsForSymbolFile(debugName, breakpadId).join('/');
}

async function getSymbolDumpFromSymbolServer(debugName, breakpadId) {
  const url = urlForSymFile(debugName, breakpadId);

  let response;
  try {
    response = await fetch(url);
  } catch (e) {
    console.log(`received error fetching ${url}`);
    console.error(e);
  }

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`got error status ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return new Uint8Array(arrayBuffer);
}

function getContainingObjdirDist(path) {
  let curPath = path;
  let curPathBasename = OS.Path.basename(curPath);
  while (curPathBasename) {
    if (curPathBasename === 'dist') {
      return curPath;
    }
    const parentDirPath = OS.Path.dirname(curPath);
    if (curPathBasename === 'bin') {
      return parentDirPath;
    }
    curPath = parentDirPath;
    curPathBasename = OS.Path.basename(curPath);
  }
  return null;
}

function filePathForSymFileInObjDir(binaryPath, debugName, breakpadId) {
  // `mach buildsymbols` generates symbol files located
  // at /path/to/objdir/dist/crashreporter-symbols/.
  const objDirDist = getContainingObjdirDist(binaryPath);
  if (!objDirDist) {
    return null;
  }
  return OS.Path.join(...[
    objDirDist, 'crashreporter-symbols',
    ...pathComponentsForSymbolFile(debugName, breakpadId)]);
}

function getSymbolsFromExistingDumpInObjDir(path, debugName, breakpadId) {
  return Promise.resolve().then(() => {
    const symFilePath = filePathForSymFileInObjDir(path, debugName, breakpadId);
    if (symFilePath === null) {
      throw new Error(`Didn't detect whether ${debugName} ${breakpadId} is in an objdir (path: ${path})`);
    }

    return OS.File.read(symFilePath);
  });
}

const symbolCache = new Map();

async function primeSymbolStore(libs) {
  const platform = getPlatform();

  for (const { debugName, breakpadId, path, arch } of libs) {
    symbolCache.set(urlForSymFile(debugName, breakpadId), {
      debugName, breakpadId, path, platform, arch,
    });
  }
}

async function getSymbols(debugName, breakpadId) {
  const cachedInfo = symbolCache.get(urlForSymFile(debugName, breakpadId));
  let path, platform, arch;
  if (cachedInfo) {
    path = cachedInfo.path;
    platform = cachedInfo.platform.toLowerCase();
    arch = cachedInfo.arch;
  }

  // We have multiple options for obtaining symbol information for the given
  // binary. We try them in sequence, starting with those that are cheapest
  // and most likely to succeed.
  //  (1) Using existing symbol dumps stored in the object directory of a local
  //      Firefox build, generated using `mach buildsymbols` [requires path]
  //  (2) Using symbol dumps from the Mozilla symbol server [only requires
  //      debugName + breakpadId]
  //  (3) Using the command line tool `nm` [linux only, requires path]
  //  (4) Using the tool dump_syms [mac + linux only, requires path]
  //
  // Each of these options can go wrong for a variety of reasons, so on failure
  // we will try the next one.
  // (1) will fail if this is not a local build that's running from the object
  // directory or if the user hasn't run `mach buildsymbols` on it.
  // (2) will fail if this is not an official mozilla build (e.g. Nightly) or a
  // known system library.
  // (3) will fail on non-Linux or if `nm` is not available.
  // (4) will fail on platforms other than Mac or Linux, or if the binary is
  // very large. For example, libxul.so on Linux with debug information is
  // usually too large (> 1GB).
  const haveAbsolutePath = path && OS.Path.split(path).absolute;
  if (haveAbsolutePath) {
    try {
      const symbolDump = await getSymbolsFromExistingDumpInObjDir(path, debugName, breakpadId);
      return await parseSym(symbolDump);
    } catch (e) {
      console.warn(e);
    }
  }

  // (2) Try to obtain a symbol dump from the Mozilla symbol server.
  let symbolDump = await getSymbolDumpFromSymbolServer(debugName, breakpadId);

  if (symbolDump) {
    return await parseSym(symbolDump);
  }

  if (!haveAbsolutePath) {
    throw new Error(`Cannot dump symbols from library ${debugName} ${breakpadId} because the absolute path to the binary is not known.`);
  }

  // (3) Use `nm` to obtain symbols.
  if (platform === 'linux') {
    try {
      return await getSymbolsFromNM(path);
    } catch (e) {
      console.error(e);
    }
  }

  // (4) Run dump_syms to obtain a symbol dump.
  symbolDump = await dumpSyms(path, platform, arch);
  return await parseSym(symbolDump);
}

function listClientTabs(client) {
  return new Promise((resolve, reject) => {
    client.listTabs(response => {
      if (!response.error) {
        resolve(response);
      } else {
        reject(response.error + ': ' + response.message);
      }
    });
  });
}

async function profilerForClient(client) {
  const profilerActor = (await listClientTabs(client)).tabs[0].profilerActor;

  function request(msgName, args = {}) {
    return new Promise((resolve, reject) => {
      const msg = Object.assign({ to: profilerActor, type: msgName }, args);
      // console.log('request:', msg);
      client.request(msg, response => {
        // console.log(msgName + ' response:', response);
        if (!response.error) {
          resolve(response);
        } else {
          reject(response.error + ': ' + response.message);
        }
      });
    });
  }

  function startProfiler(entries, interval, features, threads) {
    // Requesting stackwalk seems to crash non-nightly Firefox for Android builds...
    const featuresWithoutStackWalk = features.filter(f => f !== 'stackwalk');
    return request('startProfiler', {
      entries,
      interval,
      features: featuresWithoutStackWalk,
      threadFilters: threads
    });
  }

  function stopProfiler() {
    return request('stopProfiler');
  }

  function pauseProfiler() {
    return Promise.reject(new Error('pausing and resuming is not implemented by the ProfilerActor'));
  }

  function resumeProfiler() {
    return Promise.reject(new Error('pausing and resuming is not implemented by the ProfilerActor'));
  }

  async function isRunning() {
    return (await request('isActive')).isActive;
  }

  let randomLibs = null;

  async function getProfile() {
    const profile = (await request('getProfile')).profile;
    randomLibs = JSON.parse(JSON.stringify(profile.libs));
    return profile;
  }

  async function getSharedLibraryInformation() {
    try {
      // This is broken at the moment, see bug 1350503.
      // return (await request('sharedLibraries')).sharedLibraries;
    } catch (e) { }

    // If sharedLibraries does not exist, then we're connected to a
    // pre-bug 1329111 build and need to massage the data a little so that it
    // has the shape that we need.

    let sli;
    try {
      sli = (await request('getSharedLibraryInformation')).sharedLibraryInformation;
    } catch (e) {
      if (randomLibs) {
        return randomLibs;
      }
      return (await getProfile()).libs;
    }
    let json = JSON.parse(sli);
    return json.map(lib => {
      let debugName, breakpadId;
      if ('breakpadId' in lib) {
        debugName = lib.name.substr(lib.name.lastIndexOf("/") + 1);
        breakpadId = lib.breakpadId;
      } else {
        debugName = lib.pdbName;
        let pdbSig = lib.pdbSignature.replace(/[{}-]/g, "").toUpperCase();
        breakpadId = pdbSig + lib.pdbAge;
      }
      // Before bug 1329111, the path was in the 'name' property on macOS and
      // Linux, and unobtainable on Windows.
      const path = lib.path || lib.name;
      const arch = lib.arch || 'arm';
      return Object.assign({}, lib, { debugName, breakpadId, path, arch });
    });
  }

  return {
    start: startProfiler,
    stop: stopProfiler,
    pause: pauseProfiler,
    resume: resumeProfiler,
    isRunning: isRunning,
    getProfile: getProfile,
    getSharedLibraryInformation: getSharedLibraryInformation,
    platform: {
      platform: 'Android',
      arch: 'arm'
    },
  };
}

/**
 * This is the add-on's panel, wrapping the tool's contents.
 *
 * @param nsIDOMWindow iframeWindow
 *        The iframe window containing the tool's markup and logic.
 * @param Toolbox toolbox
 *        The developer tools toolbox, containing all tools.
 * @param function messageCallback
 *        The callback for when the devtools panel posts a message up.
 */
class ProfilerDevtoolsPanel {
  constructor(iframeWindow, toolbox, messageCallback) {
    this.panelWin = iframeWindow;
    this.toolbox = toolbox;
    this.messageCallback = messageCallback;
    EventEmitter.decorate(this);
  }

  /**
   * Open is effectively an asynchronous constructor.
   * Called when the user select the tool tab.
   *
   * @return object
   *         A promise that is resolved when the tool completes opening.
   */
  async open() {
    this.onReady();

    this.isReady = true;
    this.emit("ready");
    return this;
  }

  /**
   * Called when the user closes the toolbox or disables the add-on.
   *
   * @return object
   *         A promise that is resolved when the tool completes closing.
   */
  async destroy() {
    this.isReady = false;
    this.emit("destroyed");
  }

  sendMessage(message) {
    this.panelWin.postMessage(message, '*');
  }

  onReady() {
    this.panelWin.postMessage({ type: 'ParentReady' }, '*');

    this.panelWin.addEventListener('message', (event) => {
      if (event.source != this.panelWin) {
        return;
      }

      this.messageCallback(event.data);
    });
  }
}

const isRunningObserver = {
  _observers: new Set(),
  _isListening: false,

  observe: function (aSubject, aTopic, aData) {
    switch (aTopic) {
      case "profiler-started":
      case "profiler-stopped": {
        // Call observer(false) or observer(true), but do it through a promise
        // so that it's asynchronous.
        // We don't want it to be synchronous because of the observer call in
        // addObserver, which is asynchronous, and we want to get the ordering
        // right.
        const isRunningPromise = Promise.resolve(aTopic === "profiler-started");
        for (observer of this._observers) {
          isRunningPromise.then(observer);
        }
      }
      default:
    }
  },

  _startListening: function () {
    if (!this._isListening) {
      this._isListening = true;
      Services.obs.addObserver(this, "profiler-started", false);
      Services.obs.addObserver(this, "profiler-stopped", false);
    }
  },

  _stopListening: function () {
    if (this._isListening) {
      this._isListening = false;
      Services.obs.removeObserver(this, "profiler-started", false);
      Services.obs.removeObserver(this, "profiler-stopped", false);
    }
  },

  addObserver: function(observer) {
    this._startListening();
    this._observers.add(observer);
    isRunning().then(observer);
  },

  removeObserver: function(observer) {
    this._observers.delete(observer);
    if (this._observers.size === 0) {
      this._stopListening();
    }
  }
};

const toolDefinitionMap = new Map();

let panelId = 1;
const panelMap = new Map();

class API extends ExtensionAPI {

  onShutdown(reason) {
    const { extension } = this;

    // Destroy the registered devtools_page definition on extension shutdown.
    if (toolDefinitionMap.has(extension)) {
      gDevTools.unregisterTool(toolDefinitionMap.get(extension));
      toolDefinitionMap.delete(extension);
    }
  }

  getAPI(context) {
    const { extension } = this;

    const onRunningChanged = new SingletonEventManager(context,
                                                       'profiler.onRunningChanged',
                                                       fire => {
      isRunningObserver.addObserver(fire.async);
      return () => {
        isRunningObserver.removeObserver(fire.async);
      }
    });

    const onDevtoolsPanelMessage = new SingletonEventManager(context,
                                                         'profiler.onDevtoolsPanelMessage',
                                                         fire => {
      const listener = (messageName, {panelID, data}) => {
        fire.async(data, panelID);
      };

      extension.on('DevtoolsPanelMessage', listener);

      return () => {
        extension.off('DevtoolsPanelMessage', listener);
      };
    });

    const baseToolDefinition = {

      // The position of the tool's tab within the toolbox
      ordinal: 99,
      // Main keybinding key (used as a keyboard shortcut).
      key: "",
      // Main keybinding modifiers.
      modifiers: "",

      // The url of the icon, displayed in the Toolbox.
      invertIconForLightTheme: false,

      // If the target is not supported, the toolbox will hide the tab.
      // Targets can be local or remote (used in remote debugging).
      isTargetSupported: function(target) {
        // Don't show the button on local tabs, the add-on's toolbar button is a
        // better interface than a distracting devtools tab.
        return true; //!target.isLocalTab;
      },

      // This function is called when the user select the tool tab.
      // It is called only once the tool definition's URL is loaded.
      async build(iframeWindow, toolbox) {
        const profiler = await profilerForClient(toolbox.target.client);
        const id = panelId++;

        const panel = new ProfilerDevtoolsPanel(iframeWindow, toolbox, data => {
          extension.emit('DevtoolsPanelMessage', { panelID: id, data });
        });

        panelMap.set(id, { profiler, panel });
        panel.on('destroyed', () => {
          panelMap.delete(id);
        });

        return panel.open();
      }
    };

    const profiler = {
      start: startProfiler,
      stop: stopProfiler,
      pause: pauseProfiler,
      resume: resumeProfiler,
      isRunning: isRunning,
      getProfile: getProfile,
      getSharedLibraryInformation: getSharedLibraryInformation
    };

    function getProfilerBase(remotePanelId) {
      if (remotePanelId !== null) {
        const obj = panelMap.get(remotePanelId);
        if (obj) {
          return obj.profiler;
        } else {
          throw new Error('Panel is no longer active.')
        }
      } else {
        return profiler;
      }
    }

    return {
      profiler: {
        async start(entries, interval, features, threads, panelID = null) {
          await getProfilerBase(panelID).start(entries, interval, features, threads)
        },
        async stop(panelID = null) {
          await getProfilerBase(panelID).stop();
        },

        async pause(panelID = null) {
          await getProfilerBase(panelID).pause();
        },

        async resume(panelID = null) {
          await getProfilerBase(panelID).resume();
        },

        async isRunning(panelID = null) {
          return await getProfilerBase(panelID).isRunning();
        },

        async getProfile(panelID = null) {
          return await getProfilerBase(panelID).getProfile();
        },

        async primeSymbolStore(panelID = null) {
          const libs = await getProfilerBase(panelID).getSharedLibraryInformation();
          return await primeSymbolStore(libs);
        },

        getSymbols: getSymbols,

        onRunningChanged: onRunningChanged.api(),

        onDevtoolsPanelMessage: onDevtoolsPanelMessage.api(),

        sendDevtoolsPanelMessage(panelID, message) {
          const obj = panelMap.get(panelID);
          if (obj) {
            obj.panel.sendMessage(message);
          } else {
            throw new Error('Panel does not exist');
          }
        },

        registerDevtoolsPanel(id, options) {
          options.id = id;
          options.icon = extension.baseURI.resolve(options.icon);
          options.url = extension.baseURI.resolve(options.url);

          const toolDefinition = Object.assign({}, baseToolDefinition, options, { id });
          gDevTools.registerTool(toolDefinition);
          toolDefinitionMap.set(extension, toolDefinition);
        }
      }
    };
  }
}
