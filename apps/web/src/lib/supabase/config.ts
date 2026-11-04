export type SupabasePublicConfigResult =
  | {
      status: "ready";
      url: string;
      anonKey: string;
    }
  | {
      status: "missing_configuration";
    };

type PublicEnvironment = Record<string, string | undefined>;

function readTrimmedValue(
  environment: PublicEnvironment,
  key: "VITE_SUPABASE_URL" | "VITE_SUPABASE_ANON_KEY",
): string | undefined {
  const value = environment[key]?.trim();

  return value === "" || value === undefined ? undefined : value;
}

function isSupportedSupabaseUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== "";
  } catch {
    return false;
  }
}

export function readSupabasePublicConfig(
  environment: PublicEnvironment,
): SupabasePublicConfigResult {
  const url = readTrimmedValue(environment, "VITE_SUPABASE_URL");
  const anonKey = readTrimmedValue(environment, "VITE_SUPABASE_ANON_KEY");

  if (url === undefined || anonKey === undefined || !isSupportedSupabaseUrl(url)) {
    return { status: "missing_configuration" };
  }

  return { status: "ready", url, anonKey };
}
