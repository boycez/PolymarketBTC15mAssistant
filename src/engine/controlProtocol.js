export const CONTROL_PROTOCOL_VERSION = 1;

const CONTROL_ACTIONS = new Set([
  "request-arm",
  "confirm-arm",
  "cancel-arm",
  "stop",
  "cancel-all"
]);

export function parseControlCommand(line) {
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("Control command must be valid JSON.");
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Control command must be a JSON object.");
  }
  const allowedKeys = new Set(["type", "version", "id", "action"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length) throw new Error(`Unknown control field: ${unknownKeys[0]}.`);
  if (value.type !== "control") throw new Error("Control command type must be control.");
  if (value.version !== CONTROL_PROTOCOL_VERSION) {
    throw new Error(`Unsupported control protocol version: ${value.version ?? "missing"}.`);
  }
  if (typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.id)) {
    throw new Error("Control command id is invalid.");
  }
  if (!CONTROL_ACTIONS.has(value.action)) {
    throw new Error(`Unsupported control action: ${value.action ?? "missing"}.`);
  }
  return value;
}

export function createControlCommand({ id, action }) {
  return parseControlCommand(JSON.stringify({
    type: "control",
    version: CONTROL_PROTOCOL_VERSION,
    id,
    action
  }));
}

function result(command, runtime, { ok, code, message }) {
  return {
    type: "control-result",
    version: CONTROL_PROTOCOL_VERSION,
    id: command.id,
    action: command.action,
    ok,
    code,
    message,
    control: runtime.getControlState()
  };
}

export async function executeControlCommand(runtime, command) {
  if (runtime.mode !== "live") {
    return result(command, runtime, {
      ok: false,
      code: "MODE_NOT_LIVE",
      message: "Live controls are unavailable in Paper mode."
    });
  }

  try {
    let changed = true;
    if (command.action === "request-arm") changed = runtime.requestArm();
    if (command.action === "confirm-arm") changed = runtime.confirmArm();
    if (command.action === "cancel-arm") changed = runtime.cancelArm();
    if (command.action === "stop") {
      await runtime.disarm();
      changed = true;
    }
    if (command.action === "cancel-all") await runtime.cancelAll();

    if (!changed) {
      return result(command, runtime, {
        ok: false,
        code: "INVALID_STATE",
        message: "Control action is not valid in the current state."
      });
    }
    return result(command, runtime, {
      ok: true,
      code: "OK",
      message: "Control action completed."
    });
  } catch {
    return result(command, runtime, {
      ok: false,
      code: "ACTION_FAILED",
      message: "Control action failed."
    });
  }
}
