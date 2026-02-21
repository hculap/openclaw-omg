/**
 * Cron job registration for the OMG plugin.
 *
 * Registers all cron jobs from `createCronDefinitions` with the OpenClaw plugin API.
 * Idempotent — OpenClaw deduplicates jobs by `jobId`, so calling this function
 * multiple times with the same `api` replaces rather than duplicates registrations.
 */

import type { PluginApi } from '../plugin.js'
import type { OmgConfig } from '../config.js'
import { createCronDefinitions, type CronContext } from './definitions.js'

/**
 * Registers all OMG cron jobs with the OpenClaw plugin API.
 *
 * @param api    The OpenClaw plugin API (provides `scheduleCron`).
 * @param config The validated OMG plugin configuration.
 * @param ctx    Context shared by all cron handlers.
 */
export function registerCronJobs(api: PluginApi, config: OmgConfig, ctx: CronContext): void {
  const definitions = createCronDefinitions(ctx)
  for (const def of definitions) {
    api.scheduleCron(def.id, def.schedule, def.handler)
  }
}
