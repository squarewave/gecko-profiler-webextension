const { utils: Cu, classes: Cc, interfaces: Ci } = Components;

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/ExtensionUtils.jsm");
const { OS } = Cu.import("resource://gre/modules/osfile.jsm", {});
Cu.import(`resource://extension-profiler-api/Worker.jsm`);
Cu.importGlobalProperties(['fetch', 'Blob', 'TextDecoder', 'TextEncoder', 'URL']);

const kAsyncStackPrefName = "javascript.options.asyncstack";
let gAsyncStacksWereEnabled = false;

const {
  SingletonEventManager
} = ExtensionUtils;

function doWork(data, workerFn) {
  const blob = new Blob([`
    onmessage = e => {
      try {
        const [result, transfer] = (${workerFn.toString()})(e.data);
        postMessage({ result }, transfer);
      } catch (error) {
        postMessage({ error });
      }
    };
    `], {
    type: 'application/javascript'
  });
  const worker = new Worker(URL.createObjectURL(blob));
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

async function stopProfiler() {
  await new Promise((resolve, reject) => {
    Services.prefs.setBoolPref(kAsyncStackPrefName, gAsyncStacksWereEnabled);
    profiler().StopProfiler();
    resolve();
  });
}

async function pauseProfiler() {
  profiler().PauseSampling();
  return Promise.resolve();
}

async function resumeProfiler() {
  profiler().ResumeSampling();
  return Promise.resolve();
}

function isRunning() {
  return Promise.resolve(profiler().IsActive());
}

function getProfile() {
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

async function primeSymbolStore() {
  const libs = await getSharedLibraryInformation();
  const platform = getPlatform();

  for (const { debugName, breakpadId, path, arch } of libs) {
    symbolCache.set(urlForSymFile(debugName, breakpadId), {
      debugName, breakpadId, path, platform, arch,
    });
  }
}

function parseSym(text) {
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

    const resultAddresses = new Uint32Array(addresses);
    return [[resultAddresses, index, buffer], [resultAddresses.buffer, index.buffer, buffer.buffer]];
  }

  function convertToText(text) {
    if (typeof text === 'string') {
      return text;
    }
    if (text instanceof Uint8Array) {
      let decoder = new TextDecoder("utf-8");
      return decoder.decode(text);
    }
    if (text instanceof Blob) {
      let fileReader = new FileReaderSync();
      return fileReader.readAsText(text, "utf-8");
    }
    throw new Error("invalid input");
  }

  text = convertToText(text);

  const syms = new Map();

  let approximateSymLength = 0;

  function addSym(address, symStart, symEnd) {
    const sym = text.substring(symStart, symEnd).trimRight();
    approximateSymLength += sym.length;
    syms.set(address, sym);
  }

  let nextPublic = text.indexOf('\nPUBLIC ');
  let nextFunc = text.indexOf('\nFUNC ');
  while (nextPublic != -1 || nextFunc != -1) {
    if (nextPublic != -1 && (nextFunc == -1 || nextPublic < nextFunc)) {
      // Parse PUBLIC line: PUBLIC <address> <stack_param_size> <name>
      const addrStart = nextPublic + '\nPUBLIC '.length;
      const addrEnd = text.indexOf(' ', addrStart);
      const address = parseInt(text.substring(addrStart, addrEnd), 16);
      const symStart = text.indexOf(' ', addrEnd + 1) + 1;
      const symEnd = text.indexOf('\n', symStart);
      addSym(address, symStart, symEnd);
      nextPublic = text.indexOf('\nPUBLIC ', symEnd);
    } else {
      // Parse FUNC line: FUNC <address> <size> <stack_param_size> <name>
      const addrStart = nextFunc + '\nFUNC '.length;
      const addrEnd = text.indexOf(' ', addrStart);
      const address = parseInt(text.substring(addrStart, addrEnd), 16);
      const symStart = text.indexOf(' ', text.indexOf(' ', addrEnd + 1) + 1) + 1;
      const symEnd = text.indexOf('\n', symStart);
      addSym(address, symStart, symEnd);
      nextFunc = text.indexOf('\nFUNC ', symEnd);
    }
  }

  return convertSymsMapToExpectedSymFormat(syms, approximateSymLength);
}

async function getSymbols(debugName, breakpadId) {
  const cachedInfo = symbolCache.get(debugName, breakpadId);
  let path, platform, arch;
  if (cachedInfo) {
    path = cachedInfo.path;
    platform = cachedInfo.platform;
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
      return await doWork(symbolDump, parseSym);
    } catch (e) {
      console.warn(e);
    }
  }

  // (2) Try to obtain a symbol dump from the Mozilla symbol server.
  const symbolDump = await getSymbolDumpFromSymbolServer(debugName, breakpadId);

  if (symbolDump) {
    return await doWork(symbolDump, parseSym);
  }

  // if (!haveAbsolutePath) {
    throw new Error(`Cannot dump symbols from library ${debugName} ${breakpadId} because the absolute path to the binary is not known.`);
  // }

  // TODO
  // try {
  //   // (3) Use `nm` to obtain symbols.
  //   if (platform !== 'linux') {
  //     throw new Error('Can only use `nm` on Linux.');
  //   }
  //   // `getSymbolsFromNM` has the parsing step built in; it doesn't go
  //   // through the intermediary .sym format.
  //   return await logPromise(
  //     `dumping symbols for library ${debugName} ${breakpadId} located at ${path} using nm`,
  //     getSymbolsFromNM(path)
  //   );
  // } catch (error) {
  //   // (4) Run dump_syms to obtain a symbol dump.
  //   const symbolDump = await logPromise(
  //     `dumping symbols for library ${debugName} ${breakpadId} located at ${path} using dump_syms`,
  //     getSymbolDumpByDumpingLocalFile(path, platform, arch)
  //   );
  //   return await logPromise(
  //     `parsing symbol file for library ${debugName} ${breakpadId} obtained from dump_syms`,
  //     parseSym(symbolDump)
  //   );
  // }
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

class API extends ExtensionAPI {
  getAPI(context) {
    const onRunningChanged = new SingletonEventManager(context, 'profiler.onRunningChanged', fire => {
      isRunningObserver.addObserver(fire.async);
      return () => {
        isRunningObserver.removeObserver(fire.async);
      }
    });

    return {
      profiler: {
        start: startProfiler,
        stop: stopProfiler,
        pause: pauseProfiler,
        resume: resumeProfiler,
        isRunning: isRunning,
        getProfile: getProfile,
        primeSymbolStore: primeSymbolStore,
        getSymbols: getSymbols,
        onRunningChanged: onRunningChanged.api()
      }
    };
  }
}
