import { describe, expect, it } from "vitest";
import { larperOsLocalization as l } from "./clerk-localization";

describe("larperOsLocalization", () => {
  it("uses Larper's copy for the sign-in and sign-up forms", () => {
    expect(l.signIn?.start?.subtitle).toBe("welcome back. today's quest is waiting.");
    expect(l.signUp?.start?.subtitle).toBe("one quest a day, picked for you.");
    expect(l.formFieldLabel__emailAddress).toBe("email");
    expect(l.formButtonPrimary).toBe("continue");
    expect(l.dividerText).toBe("or");
  });

  it("writes errors as plain sentences that start with a capital and end with a full stop", () => {
    for (const [key, text] of Object.entries(l.unstable__errors ?? {})) {
      expect(text, key).toMatch(/^[A-Z].*\.$/);
    }
  });
});
