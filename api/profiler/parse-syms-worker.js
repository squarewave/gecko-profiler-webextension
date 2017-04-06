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

function parseSym(text) {
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

onmessage = e => {
  try {
    const [result, transfer] = parseSym(e.data);
    postMessage({ result }, transfer);
  } catch (error) {
    postMessage({ error });
  }
};
