// IAC-384 test helpers. Synthetic photo bytes and a good model answer in the flat wire shape. Nothing here calls a model or reads a key.
// The marker is embedded in the image bytes so a test can search the database and the logs for it, as raw text and as base64.
export const PNG_MARKER = "PHOTOMARKERxq7Zk93vLm2Rt8";
export const pngBytes = (marker: string = PNG_MARKER): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`IHDR-fake-${marker}-`), Buffer.alloc(64, 7)]);
export const jpegBytes = (marker: string = PNG_MARKER): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`JFIF-fake-${marker}-`), Buffer.alloc(64, 9)]);
export const goodWire = (): Record<string, unknown> => ({ readable: true, vendor: "Cedar Science Shop", date_printed: "2026-10-14",
  lines: [{ text: "Science experiment kit", amount_cents: 300 }, { text: "Blank writing notebook", amount_cents: 200 }, { text: "Sandwiches and apple juice", amount_cents: 100 }],
  subtotal_cents: 600, tax_cents: -1, total_cents: 600 });
