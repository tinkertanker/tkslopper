// Native-app example. Browser apps should use a trusted product backend until an
// environment-specific CORS policy is designed. Never embed a service credential.
export async function activateAndClassify(options: {
  controlPlaneUrl: string;
  gatewayUrl: string;
  accessCode: string;
  installationId: string;
  imageDataUrl: string;
}): Promise<unknown> {
  const activation = await fetch(`${options.controlPlaneUrl}/v1/activations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      access_code: options.accessCode,
      device_id: options.installationId,
      capabilities: ["vision.classify.v1"],
      ttl_seconds: 300,
    }),
  });
  if (!activation.ok)
    throw new Error(`activation failed with HTTP ${activation.status}`);
  const grant: unknown = await activation.json();
  if (
    typeof grant !== "object" ||
    grant === null ||
    !("access_token" in grant) ||
    typeof grant.access_token !== "string"
  ) {
    throw new Error("activation returned an invalid grant");
  }

  const response = await fetch(`${options.gatewayUrl}/v1/responses`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grant.access_token}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      model: "vision.classify.v1",
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: "Classify this synthetic fixture using the caller-owned policy.",
            },
            {
              type: "input_image",
              image_url: options.imageDataUrl,
              detail: "low",
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "classification",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["label"],
            properties: { label: { type: "string" } },
          },
        },
      },
      max_output_tokens: 128,
      stream: false,
    }),
  });
  if (!response.ok)
    throw new Error(`inference failed with HTTP ${response.status}`);
  return response.json();
}
