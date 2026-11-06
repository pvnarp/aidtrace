import { describe, expect, it } from "vitest";
import { RAIL_RECEIPT_PHOTO, RAIL_RECEIPT_PHOTO_OR_TYPED, aiCard, paypalCard, railLines, type Stage } from "../src/app/shell-copy";
import { traceSteps } from "../src/app/trace";

// RS-01 to RS-03 (IAC-384 follow-up, docs/GATE_REPORT.md section 84). Wording only: the new receipt page says "Photo or typed text" when the photo reader is on.
const ai = aiCard({ applicable: true, suggestion: "NONE", confirmed: false, aiAccepted: false, savedModel: null, configured: { name: "Claude Haiku 5.5", shellName: "Claude Haiku" } });
const paypal = paypalCard({ claimStatus: null, approvals: 0, payout: null });
const base = { typedReceipt: true, ai, approvals: 0, paypal } as const;
const stages: Stage[] = [1, 2, 3, 4, 5];

describe("RS-01 the photoIntake flag names both ways in", () => {
  it("railLines and traceSteps read Photo or typed text for the Receipt step, at every stage", () => {
    expect(RAIL_RECEIPT_PHOTO_OR_TYPED).toBe("Photo or typed text");
    for (const stage of stages) {
      const rail = railLines({ stage, ...base, photoIntake: true });
      expect(rail[0]!.name).toBe("Receipt"); expect(rail[0]!.state).toBe("Photo or typed text");
      expect(traceSteps({ stage, ...base, photoIntake: true })[0]!.detail).toBe("Photo or typed text");
    }
  });
  it("changes only the Receipt line", () => {
    for (const stage of stages) {
      expect(railLines({ stage, ...base, photoIntake: true }).slice(1)).toEqual(railLines({ stage, ...base }).slice(1));
      expect(traceSteps({ stage, ...base, photoIntake: true }).slice(1)).toEqual(traceSteps({ stage, ...base }).slice(1));
    }
  });
});

describe("RS-02 without the flag the old words stay", () => {
  it("typed and preclassified receipts keep their words, with the flag absent or false", () => {
    for (const stage of stages) {
      expect(railLines({ stage, ...base })[0]!.state).toBe("Typed text and amounts");
      expect(railLines({ stage, ...base, photoIntake: false })[0]!.state).toBe("Typed text and amounts");
      expect(railLines({ stage, ...base, typedReceipt: false })[0]!.state).toBe("Preclassified example");
      expect(traceSteps({ stage, ...base })[0]!.detail).toBe("Typed text and amounts");
    }
  });
});

describe("RS-03 a saved photo link wins over the intake hint", () => {
  it("photoReceipt gives Read from a photo even when photoIntake is also set, because the saved receipt is a fact and the intake line is only a hint before a receipt exists", () => {
    for (const stage of stages) {
      expect(railLines({ stage, ...base, photoReceipt: true, photoIntake: true })[0]!.state).toBe(RAIL_RECEIPT_PHOTO);
      expect(traceSteps({ stage, ...base, photoReceipt: true, photoIntake: true })[0]!.detail).toBe("Read from a photo");
    }
  });
});
