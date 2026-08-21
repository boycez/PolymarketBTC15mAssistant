function validatePrivateKey(value) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("Polymarket private key must be 0x followed by 64 hexadecimal characters.");
  }
  return value;
}

export function readHiddenTerminalInput({
  prompt,
  input = process.stdin,
  output = process.stdout
}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Live private-key entry requires an interactive terminal.");
  }

  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const wasRaw = input.isRaw === true;

    const cleanup = () => {
      input.off("data", onData);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
    };

    const finish = (error = null) => {
      cleanup();
      output.write("\n");
      if (error) reject(error);
      else resolve(value.trim());
    };

    const onData = (chunk) => {
      for (const character of String(chunk)) {
        if (character === "\u0003" || character === "\u001b") {
          finish(new Error("Private-key entry canceled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= " ") value += character;
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

export async function acquireLivePrivateKey({
  mode,
  enabled,
  input = process.stdin,
  output = process.stdout,
  nodeVersion = process.versions.node
}) {
  if (mode !== "live" || !enabled) return "";

  const nodeMajor = Number(String(nodeVersion).split(".")[0]);
  if (nodeMajor < 24) throw new Error("Live trading requires Node.js 24 or newer.");

  const privateKey = await readHiddenTerminalInput({
    prompt: "Polymarket signer private key (hidden): ",
    input,
    output
  });
  return validatePrivateKey(privateKey);
}