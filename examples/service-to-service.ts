import { requireCompleteChatText } from "./chat-completion";

export {};

const controlPlaneUrl = process.env.TKSLOPPER_CONTROL_PLANE_URL;
const gatewayUrl = process.env.TKSLOPPER_GATEWAY_URL;
const serviceCredential = process.env.TKSLOPPER_SERVICE_CREDENTIAL;

if (!controlPlaneUrl || !gatewayUrl || !serviceCredential)
  throw new Error("required tkslopper environment is missing");

const exchange = await fetch(`${controlPlaneUrl}/v1/token`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${serviceCredential}`,
    "content-type": "application/json",
  },
  body: JSON.stringify({ capabilities: ["text.chat.v1"], ttl_seconds: 300 }),
});
if (!exchange.ok)
  throw new Error(`grant exchange failed with HTTP ${exchange.status}`);
const grant: unknown = await exchange.json();
if (
  typeof grant !== "object" ||
  grant === null ||
  !("access_token" in grant) ||
  typeof grant.access_token !== "string"
) {
  throw new Error("token exchange returned an invalid grant");
}

const inference = await fetch(`${gatewayUrl}/v1/chat/completions`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${grant.access_token}`,
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    model: "text.chat.v1",
    messages: [
      { role: "user", content: "A synthetic, non-sensitive example request." },
    ],
    max_completion_tokens: 256,
    stream: false,
  }),
});
if (!inference.ok)
  throw new Error(`inference failed with HTTP ${inference.status}`);
const completion: unknown = await inference.json();
console.log(requireCompleteChatText(completion));
