import { z } from "zod";
import {
  HttpError,
  jsonResponse,
  modelCatalogueDataSchema,
  randomId,
  readJsonBody,
  readModelCatalogue,
  zodMessage,
} from "@tkslopper/shared";
import { requireBrowserAdmin, requireNamedAdmin } from "./admin-access";

const publicationSchema = z
  .object({
    revision: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER - 1),
    data: modelCatalogueDataSchema,
  })
  .strict();

/** Browser-only administration; never registered on the bearer-token admin API. */
export async function administerModelCatalogue(
  request: Request,
  env: { DB: D1Database; DASHBOARD_ACCESS_AUD?: string },
  access?: CloudflareAccessContext,
): Promise<Response> {
  if (request.method === "GET") {
    await requireNamedAdmin(env, access);
    const revision = new URL(request.url).searchParams.get("revision");
    if (revision !== null) {
      if (
        !/^[1-9][0-9]*$/u.test(revision) ||
        !Number.isSafeInteger(Number(revision))
      )
        throw new HttpError(
          400,
          "invalid_request",
          "invalid catalogue revision",
        );
      const row = await env.DB.prepare(
        "SELECT revision, data_json FROM model_catalogue_revisions WHERE revision = ?",
      )
        .bind(Number(revision))
        .first<{ revision: number; data_json: string }>();
      if (!row)
        throw new HttpError(404, "not_found", "catalogue revision not found");
      return jsonResponse({
        revision: row.revision,
        data: modelCatalogueDataSchema.parse(JSON.parse(row.data_json)),
      });
    }
    const current = await readModelCatalogue(env.DB);
    const history = await env.DB.prepare(
      `SELECT r.revision, r.created_at, d.email AS actor_email,
              json_array_length(r.data_json) AS entry_count
         FROM model_catalogue_revisions r
         LEFT JOIN dashboard_admins d ON d.actor_hash = r.actor_hash
        ORDER BY r.revision DESC LIMIT 25`,
    ).all();
    return jsonResponse({ ...current, history: history.results });
  }
  if (request.method !== "POST")
    throw new HttpError(405, "invalid_request", "method not allowed");
  const actorHash = await requireBrowserAdmin(request, env, access);
  const parsed = publicationSchema.safeParse(
    await readJsonBody(request, 131_072),
  );
  if (!parsed.success)
    throw new HttpError(400, "invalid_request", zodMessage(parsed.error));
  const { revision, data } = parsed.data;
  const nextRevision = revision + 1;
  const now = Math.floor(Date.now() / 1000);
  const [publication] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO model_catalogue_revisions (revision, data_json, actor_hash, created_at)
       SELECT ?, ?, ?, ? WHERE (SELECT COALESCE(MAX(revision), 0) FROM model_catalogue_revisions) = ?`,
    ).bind(nextRevision, JSON.stringify(data), actorHash, now, revision),
    env.DB.prepare(
      `INSERT INTO admin_audit (id, action, resource_type, resource_id, actor_hash, created_at)
       SELECT ?, 'publish', 'model_catalogue', ?, ?, ? WHERE changes() > 0`,
    ).bind(randomId("audit"), String(nextRevision), actorHash, now),
  ]);
  if (!publication!.meta.changes)
    throw new HttpError(
      409,
      "conflict",
      "Catalogue changed. Reload the latest revision before publishing; your draft has not been saved.",
    );
  return jsonResponse({ revision: nextRevision, data });
}
