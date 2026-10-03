// Whether the model sees images, and what it reads when it does not.

import { describe, it, expect, beforeEach } from "vitest";
import {
  modelSeesImages, setModelSeesImages, resetVision, isImageRefusal, imageUnseenText, stripImages,
} from "../../../src/agent/vision.js";
import { seesImagesFrom } from "../../../src/providers/models.js";

beforeEach(() => resetVision());

describe("seesImagesFrom (provider metadata)", () => {
  it("reads input_modalities", () => {
    expect(seesImagesFrom({ input_modalities: ["text"] })).toBe(false);
    expect(seesImagesFrom({ input_modalities: ["text", "image"] })).toBe(true);
  });
  it("reads the legacy modality string by its input side", () => {
    expect(seesImagesFrom({ modality: "text->text" })).toBe(false);
    expect(seesImagesFrom({ modality: "text+image->text" })).toBe(true);
    expect(seesImagesFrom({ modality: "text->image" })).toBe(false);
  });
  it("says nothing when the provider says nothing", () => {
    expect(seesImagesFrom(undefined)).toBe(null);
    expect(seesImagesFrom({})).toBe(null);
  });
});

describe("what is known", () => {
  it("starts unknown", () => {
    expect(modelSeesImages()).toBe(null);
  });
  it("a refusal is not overwritten by metadata arriving late", () => {
    setModelSeesImages(false, "provider-refusal");
    setModelSeesImages(true, "provider-metadata");
    expect(modelSeesImages()).toBe(false);
  });
  it("reset forgets", () => {
    setModelSeesImages(false, "provider-refusal");
    resetVision();
    expect(modelSeesImages()).toBe(null);
  });
});

describe("isImageRefusal", () => {
  const err = (statusCode, message) => Object.assign(new Error(message), { statusCode });
  it("matches a client error about image input", () => {
    expect(isImageRefusal(err(404, 'API 404: {"error":{"message":"No endpoints found that support image input"}}'))).toBe(true);
    expect(isImageRefusal(err(400, "Invalid content type. image_url is only supported by certain models."))).toBe(true);
  });
  it("does not match server errors, rate limits or other client errors", () => {
    expect(isImageRefusal(err(500, "image input pipeline crashed"))).toBe(false);
    expect(isImageRefusal(err(429, "image input rate limited"))).toBe(false);
    expect(isImageRefusal(err(400, "context length exceeded"))).toBe(false);
  });
});

describe("what the model reads", () => {
  it("states the fact and the file, names no tool", () => {
    const t = imageUnseenText("mcp_screenbox_desktop_screenshot", "C:\\s\\img-001.jpeg", "");
    expect(t).toContain("cannot view images");
    expect(t).toContain("C:\\s\\img-001.jpeg");
    expect(t).not.toMatch(/tool_search|desktop_look|use |try /i);
  });
  it("stripImages turns every image part into that text", () => {
    const msgs = [
      { role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }, { type: "text", text: "[Tool result image]" }], _isImage: true, _imageTool: "view_image", _imagePath: "p.png" },
      { role: "user", content: "plain" },
    ];
    expect(stripImages(msgs)).toBe(1);
    expect(typeof msgs[0].content).toBe("string");
    expect(msgs[0].content).toContain("p.png");
    expect(msgs[1].content).toBe("plain");
  });
});
