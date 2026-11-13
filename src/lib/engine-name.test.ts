import { afterEach, describe, expect, it } from "vitest";

import { engineDisplayName } from "./engine-name";
import { setLocale } from "./i18n";

afterEach(() => setLocale("en"));

describe("engineDisplayName", () => {
  it("shows the engine's own name, in whatever language the person named it in", () => {
    setLocale("pt-br");
    expect(engineDisplayName({ instanceId: "my-agent", displayName: "Meu Agente" })).toBe("Meu Agente");
    expect(engineDisplayName({ instanceId: "my-agent", displayName: "My Agent" })).toBe("My Agent");
    setLocale("en");
    expect(engineDisplayName({ instanceId: "my-agent", displayName: "My Agent" })).toBe("My Agent");
  });
});
