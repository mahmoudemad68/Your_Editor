import { loadWebConfig } from "../infrastructure/config";

/** Asks the API whether its dependencies are ready. A failure is not web liveness. */
export async function apiDependenciesReady(): Promise<boolean> {
  try {
    const config = loadWebConfig();
    const response = await fetch(new URL("/ready", config.apiBaseUrl), { cache: "no-store" });
    return response.ok;
  } catch {
    return false;
  }
}
