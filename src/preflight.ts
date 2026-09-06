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

interface OpenRouterEndpoint {
  provider_name: string;
  supported_parameters?: string[];
}

const MODELS_URL = "https://openrouter.ai/api/v1/models";
const KEY_URL = "https://openrouter.ai/api/v1/key";

/**
 * Everything that can be wrong before a run starts, checked for the price of
 * three GETs. The planner drives a tool loop and the writer produces a structured
 * object, so a model that supports neither fails only after money has been
 * spent on retrieval — which is exactly what this is here to prevent. Pinned
 * writer routing is checked for the same reason: OpenRouter answers a request
 * whose provider list it cannot satisfy with a 404, mid-run.
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
  checks.push(checkWriteModel(config, models));

  checks.push(await checkWriterRouting(config, signal));

  checks.push(checkKeyShape("tavily key", config.tavilyApiKey, "tvly-"));

  return checks;
}

function checkWriteModel(config: Config, models: OpenRouterModel[] | null): Check {
  const fallback = config.writeModelFallsBack;
  const base = checkModel("write model", config.writeModel, models, []);
  return { ...base, detail: `${base.detail} — needs neither tools nor structured_outputs${fallback ? "; falling back to writer model" : ""}` };
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

/**
 * Confirms the pinned providers actually serve the writer model with the
 * structured-output support the report depends on. A name that no longer
 * appears — providers are added and dropped — would otherwise surface as
 * "No endpoints found" at synthesis time, with the whole run already paid for.
 */
async function checkWriterRouting(
  config: Config,
  signal: AbortSignal,
): Promise<Check> {
  const name = "writer routing";
  if (config.writerProviders.length === 0) {
    return {
      name,
      ok: true,
      detail:
        "unpinned — OpenRouter picks the provider (SONDE_WRITER_PROVIDERS)",
    };
  }

  const url = `${MODELS_URL}/${config.writerModel}/endpoints`;
  let endpoints: OpenRouterEndpoint[];
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.openrouterApiKey}` },
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    endpoints =
      ((await res.json()) as { data?: { endpoints?: OpenRouterEndpoint[] } })
        .data?.endpoints ?? [];
  } catch (error) {
    return {
      name,
      ok: false,
      detail: `${config.writerProviders.length} pinned provider(s) not verified: could not fetch ${url}: ${message(error)}`,
    };
  }

  const byName = new Map(endpoints.map((e) => [e.provider_name, e]));
  const unknown = config.writerProviders.filter((p) => !byName.has(p));
  const unstructured = config.writerProviders.filter(
    (p) =>
      byName.has(p) &&
      !(byName.get(p)!.supported_parameters ?? []).includes(
        "structured_outputs",
      ),
  );

  if (unknown.length > 0 || unstructured.length > 0) {
    const problems = [
      unknown.length > 0
        ? `do not serve ${config.writerModel}: ${unknown.join(", ")}`
        : null,
      unstructured.length > 0
        ? `serve it without structured_outputs: ${unstructured.join(", ")}`
        : null,
    ].filter(Boolean);
    return {
      name,
      ok: false,
      detail: `SONDE_WRITER_PROVIDERS names providers that ${problems.join("; and that ")}`,
    };
  }

  return {
    name,
    ok: true,
    detail: `pinned to ${config.writerProviders.length} of ${endpoints.length} providers, fallbacks off`,
  };
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
