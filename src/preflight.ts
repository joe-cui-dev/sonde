import type { Config } from "./config.js";

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  supported_parameters?: string[];
  pricing?: { prompt?: string; completion?: string };
}

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const KEY_URL = "https://openrouter.ai/api/v1/key";

/**
 * Everything that can be wrong before a run starts, checked for the price of
 * two GETs. The planner drives a tool loop and the writer produces a structured
 * object, so a model that supports neither fails only after money has been
 * spent on retrieval — which is exactly what this is here to prevent.
 */
export async function preflight(
  config: Config,
  options: { timeoutMs?: number } = {},
): Promise<Check[]> {
  const checks: Check[] = [];
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);

  checks.push(await checkKey(config, signal));

  let models: OpenRouterModel[] | null = null;
  try {
    const res = await fetch(MODELS_URL, { signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = ((await res.json()) as { data?: OpenRouterModel[] }).data ?? [];
    checks.push({
      name: "openrouter catalogue",
      ok: true,
      detail: `${models.length} models reachable`,
    });
  } catch (error) {
    checks.push({
      name: "openrouter catalogue",
      ok: false,
      detail: `could not fetch ${MODELS_URL}: ${message(error)}`,
    });
  }

  checks.push(
    checkModel("planner model", config.plannerModel, models, ["tools"]),
  );
  checks.push(
    checkModel("writer model", config.writerModel, models, [
      "tools",
      "structured_outputs",
    ]),
  );

  checks.push(checkKeyShape("tavily key", config.tavilyApiKey, "tvly-"));

  return checks;
}

async function checkKey(config: Config, signal: AbortSignal): Promise<Check> {
  const shape = checkKeyShape(
    "openrouter key",
    config.openrouterApiKey,
    "sk-or-",
  );
  if (!shape.ok) return shape;

  try {
    const res = await fetch(KEY_URL, {
      headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      return {
        name: "openrouter key",
        ok: false,
        detail: `rejected by OpenRouter (HTTP ${res.status}) — check the key at https://openrouter.ai/keys`,
      };
    }
    if (!res.ok) {
      return {
        name: "openrouter key",
        ok: false,
        detail: `unexpected HTTP ${res.status} from ${KEY_URL}`,
      };
    }

    const data = (await res.json()) as {
      data?: { label?: string; usage?: number; limit?: number | null };
    };
    const usage = data.data?.usage;
    const limit = data.data?.limit;
    const credit =
      typeof limit === "number"
        ? `$${(limit - (usage ?? 0)).toFixed(2)} of $${limit.toFixed(2)} left`
        : "no spend limit set";
    return {
      name: "openrouter key",
      ok: true,
      detail: `accepted${data.data?.label ? ` (${data.data.label})` : ""} — ${credit}`,
    };
  } catch (error) {
    return {
      name: "openrouter key",
      ok: false,
      detail: `could not reach ${KEY_URL}: ${message(error)}`,
    };
  }
}

function checkModel(
  name: string,
  slug: string,
  models: OpenRouterModel[] | null,
  required: string[],
): Check {
  if (models === null) {
    return {
      name,
      ok: false,
      detail: `${slug} — not verified, catalogue unavailable`,
    };
  }

  const model = models.find((m) => m.id === slug);
  if (!model) {
    const near = models
      .filter((m) => m.id.split("/")[0] === slug.split("/")[0])
      .slice(0, 4)
      .map((m) => m.id);
    return {
      name,
      ok: false,
      detail:
        `"${slug}" is not an OpenRouter model id. See https://openrouter.ai/models` +
        (near.length ? `\n      same publisher: ${near.join(", ")}` : ""),
    };
  }

  const supported = model.supported_parameters ?? [];
  const missing = required.filter((p) => !supported.includes(p));
  if (missing.length > 0) {
    return {
      name,
      ok: false,
      detail: `"${slug}" does not support: ${missing.join(", ")} — the run would fail mid-flight`,
    };
  }

  const price = model.pricing?.prompt
    ? `$${(Number(model.pricing.prompt) * 1e6).toFixed(2)}/M in, $${(Number(model.pricing.completion ?? 0) * 1e6).toFixed(2)}/M out`
    : "pricing unknown";
  const ctx = model.context_length
    ? `${(model.context_length / 1000).toFixed(0)}k ctx`
    : "context unknown";

  return { name, ok: true, detail: `${slug} — ${ctx}, ${price}` };
}

function checkKeyShape(name: string, value: string, prefix: string): Check {
  if (!value.startsWith(prefix)) {
    return {
      name,
      ok: false,
      detail: `does not start with "${prefix}" — is this the right key?`,
    };
  }
  return { name, ok: true, detail: `${prefix}…${value.slice(-4)}` };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
