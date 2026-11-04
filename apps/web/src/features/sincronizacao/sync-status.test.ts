import { describe, expect, it } from "vitest";

import { deriveSyncStatus } from "./sync-status";

describe("deriveSyncStatus", () => {
  it("requires configuration when public Supabase settings are unavailable", () => {
    expect(deriveSyncStatus({ status: "missing_configuration" })).toEqual({
      kind: "configuration_required",
      label: "Configuração pendente",
      description:
        "Configure a conexão com o Supabase antes de sincronizar operações.",
    });
  });

  it("does not claim server confirmation when public settings are ready", () => {
    expect(
      deriveSyncStatus({
        status: "ready",
        url: "https://example.supabase.co",
        anonKey: "anon-key",
      }),
    ).toEqual({
      kind: "ready_to_connect",
      label: "Pronto para conectar",
      description: "Nenhuma operação foi confirmada pelo servidor ainda.",
    });
  });
});
