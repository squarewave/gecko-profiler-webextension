const injectScript = document.createElement('script');
const injectFunction = () => {
  let gProfile = null;

  const symbolReplyPromiseMap = new Map();

  window.addEventListener('message', event => {
    if (event.source != window) {
      return;
    }

    if (event.data.type === 'ProfilerConnectToPage') {
      gProfile = event.data.payload;
      connectToPage();
      document.addEventListener("DOMContentLoaded", connectToPage);
    } else if (event.data.type === 'ProfilerGetSymbolTableReply') {
      const { debugName, breakpadId, status, result, error } = event.data;
      const { resolve, reject } = symbolReplyPromiseMap.get([debugName, breakpadId].join(':'));

      if (status === 'success') {
        const [ addresses, index, buffer ] = result;
        resolve([new Uint32Array([addresses]), new Uint32Array(index), new Uint8Array(buffer)]);
      } else {
        reject(error);
      }
    }
  });

  function connectToPage() {
    if (window.connectToGeckoProfiler) {
      window.connectToGeckoProfiler({
        getProfile: () => Promise.resolve(gProfile),
        getSymbolTable: (debugName, breakpadId) => getSymbolTable(debugName, breakpadId),
      });
    }
  }

  function getSymbolTable(debugName, breakpadId) {
    return new Promise((resolve, reject) => {
      window.postMessage({type: 'ProfilerGetSymbolTable', debugName, breakpadId}, '*');
      symbolReplyPromiseMap.set([debugName, breakpadId].join(':'), { resolve, reject });
    });
  }
};

injectScript.innerHTML = `(${injectFunction.toString()})();`;

document.documentElement.appendChild(injectScript);

const port = browser.runtime.connect({ name: 'ProfilerPage' });

window.addEventListener('message', event => {
  if (event.source != window) {
    return;
  }

  const validMessages = ['ProfilerGetSymbolTable'];
  if (validMessages.includes(event.data.type)) {
    port.postMessage(event.data);
  }
});

port.onMessage.addListener((message, sender, sendResponse) => {
  const validMessages = ['ProfilerConnectToPage', 'ProfilerGetSymbolTableReply'];
  if (validMessages.includes(message.type)) {
    window.postMessage(message, '*');
  }
});
