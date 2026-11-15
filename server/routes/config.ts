import { liveSavePatch } from "../live-config.ts";
import { signInEnvRefusal } from "../sign-in-env.ts";
import { browserEngineStatus, browserSessionId } from "../browser-engine.ts";
import { browserEngineKind } from "../browser/config.ts";
import type { BrowserCleanupCoordinator, BrowserCleanupRequest } from "../browser-lifecycle-cleanup.ts";
import { finalizeBrowserCleanupMutation, requireBrowserCleanupAcknowledged } from "../browser-lifecycle-cleanup.ts";
import type { BrowserLive } from "../browser-live.ts";
import type { BrowserRuntime } from "../browser-runtime.ts";
import { vpsAliasResourceChangeError } from "../cloud-backend.ts";
import {
  browserProfilePartitionTarget,
  browserProfileReplacementConflict,
  builtInBrowserEnabled,
  changedInstanceIds,
  engineLaunches,
  loadConfig,
  localVmMode,
  saveConfig,
  syncCredentialEnv,
  vpsSshAlias,
  type AppConfig,
} from "../config.ts";
import type { InstanceConfigMap, ModelSelection } from "../contracts.ts";
import type { RequestAuth } from "../request-auth.ts";
import { parseConfigPatchForPerson } from "../decider/config-errors.ts";
import { TEAM_PERSONAL_HINTS } from "../../shared/cloud-hints.ts";
import { DECIDER_KEY_ERROR, deciderIncludedHere, deciderPatchKey, deciderSavePatch, deciderSharedKeyUsable, type Decider } from "../decider/index.ts";
import type { ProviderRegistry } from "../harness/registry.ts";
import { forgetKey } from "../key-rejections.ts";
import type { ComputerIdleTimer } from "../computer-idle.ts";
import { PROVIDER_KEY_KINDS } from "../provider-key-check.ts";
import type { SessionRegistry } from "../sessions.ts";
import type { SharedComputerControl } from "../shared-computer-control.ts";
import type { SharedComputers } from "../shared-computers.ts";
import { parseSkillMd } from "../skills.ts";
import type { Store } from "../store.ts";
import * as tts from "../tts/index.ts";
import * as vps from "../vps-computer.ts";
import { refusalBody, userError, userErrorFields } from "../user-errors.ts";
import type { ServerErrorBody } from "../../shared/server-text.ts";
import type { Postiz } from "../postiz/service.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface BusyFlag {
  get(): boolean;
  set(busy: boolean): void;
}

export type RemoteComputerProvider = "vps";

export type ModelSelectionCheck = { ok: true; selection: ModelSelection } | ({ ok: false; status: number } & ServerErrorBody);

export type ConfigStatus = Record<string, unknown>;

export interface ConfigRouteDeps {
  store: Pick<Store, "bots" | "patchBot" | "clearVoiceSelections">;
  cfg: AppConfig;
  registry: Pick<ProviderRegistry, "get" | "forgetSnapshots">;
  sessions: Pick<SessionRegistry, "revalidateEmailSessions">;
  browserCleanup: Pick<BrowserCleanupCoordinator, "hasPendingProfile" | "prepare" | "abort" | "commit" | "ensure">;
  browserLive: Pick<BrowserLive, "closeAll" | "closeForSession">;
  browserRuntime: Pick<BrowserRuntime, "heldBy">;
  usedBrowserSessions: Pick<Map<string, { command: string; env: Record<string, string> }>, "get" | "delete">;
  closeBrowser(session: string, spec: { command: string; env: Record<string, string> }): Promise<boolean>;
  /** After browserEngine.engine changed: closes the viewers and the browsers the other engine ran. */
  browserEngineSwitched(): void;
  decider: Pick<Decider, "testKey">;
  sharedComputers: Pick<SharedComputers, "close">;
  sharedComputerControl: Pick<SharedComputerControl, "close">;
  cloudHome: boolean;
  lendingEnabled(): boolean;
  providerConfigs(): InstanceConfigMap;
  localVmIdleMs(): number;
  localVmIdles: { values(): Iterable<Pick<ComputerIdleTimer, "setIdleMs">> };
  localVmActiveThreads: { readonly size: number };
  localVmLifecycleBusy: { readonly size: number };
  localVmImageBusy: Pick<BusyFlag, "get">;
  localVmModeChangeBusy: Pick<BusyFlag, "set">;
  providerConfigBusy: BusyFlag;
  computerProviderConfigTransitions: Pick<Set<RemoteComputerProvider>, "add" | "delete">;
  managedComputerOwners(): vps.ManagedVpsOwner[];
  providerOperationConflict(provider: RemoteComputerProvider): string | null;
  perBotLocalVmCountForModeChange(): Promise<number | null>;
  checkedModelSelection(raw: unknown, current?: { selection: ModelSelection; busy: boolean }, requireAvailableModel?: boolean): ModelSelectionCheck;
  policyModelRefusal(instance: { instanceId: string; driverKind: string }): string | undefined;
  browserSessionSpec(binaryPath: string, session: string, profile: string | undefined): { command: string; env: Record<string, string> };
  configStatus(): ConfigStatus;
  /** What this caller is shown: a client sees configured-or-not only; on a Team Cloud the profile is the caller's own. */
  configForAccess(status: ConfigStatus, auth: RequestAuth): unknown;
  /** A Team Cloud only: Settings → Profile saves the signed-in person's own profile, never the server's. False: nobody
   * signed in to save it for. */
  ownProfile?(auth: RequestAuth, profile: { name?: string; avatarUrl?: string; aboutMe?: string }): boolean;
  /** On a Team Cloud: the welcome's own hints (TEAM_PERSONAL_HINTS) go to this person's record, never the team's; false
   * for a caller with no team session. */
  ownHints?(auth: RequestAuth, hints: string[]): boolean;
  revokeEngineCapabilities(engines: ReadonlySet<string>): void;
  reloadProviders(before: Record<string, unknown>): Promise<void>;
  broadcast(payload: Record<string, unknown>): void;
  drainQueuedSends(): void;
  /** Postiz: a key is checked at its address before it is saved, and the `postiz` server follows the saved key. */
  postiz?: Pick<Postiz, "configCheck" | "configSaved">;
}

export function createConfigRoutes(deps: ConfigRouteDeps): RouteHandler {
  const {
    store, cfg, registry, sessions, browserCleanup, browserLive, browserRuntime, usedBrowserSessions, decider,
    closeBrowser, browserEngineSwitched, sharedComputers, sharedComputerControl, cloudHome: CLOUD_HOME, lendingEnabled, providerConfigs,
    localVmIdleMs, localVmIdles, localVmActiveThreads, localVmLifecycleBusy, localVmImageBusy, localVmModeChangeBusy,
    providerConfigBusy, computerProviderConfigTransitions, managedComputerOwners, providerOperationConflict,
    perBotLocalVmCountForModeChange, checkedModelSelection, policyModelRefusal, browserSessionSpec, configStatus,
    configForAccess, revokeEngineCapabilities, reloadProviders, broadcast, drainQueuedSends, ownProfile, ownHints, postiz,
  } = deps;
  return async ({ req, res, url, path, method, auth, json, readBody }) => {
    // API keys are never echoed back: booleans only.
    if (method === "GET" && path === "/api/config") {
      return json(res, 200, configForAccess(configStatus(), auth));
    }
    if ((method === "PUT" || method === "PATCH") && path === "/api/config") {
      const body = await readBody(req);
        const patch = parseConfigPatchForPerson(body);
      if (patch.profile && ownProfile) {
        // The address is the verified claim's; a profile names no other.
        const { email: _email, ...own } = patch.profile;
        if (!ownProfile(auth, own)) return json(res, 403, { error: "Sign in to this team to have a profile." });
        delete patch.profile;
        if (!Object.keys(patch).length) {
          broadcast({ kind: "config", ...configStatus() });
          return json(res, 200, configForAccess(configStatus(), auth));
        }
      }
      if (patch.onboarding?.hintsSeen && ownHints) {
        const mine = patch.onboarding.hintsSeen.filter((hint) => TEAM_PERSONAL_HINTS.has(hint));
        if (mine.length && ownHints(auth, mine)) {
          // The team's record keeps what it had of these; only this person's changes.
          const kept = (cfg.onboarding?.hintsSeen ?? []).filter((hint) => TEAM_PERSONAL_HINTS.has(hint));
          patch.onboarding = { ...patch.onboarding, hintsSeen: [...new Set([...patch.onboarding.hintsSeen.filter((hint) => !TEAM_PERSONAL_HINTS.has(hint)), ...kept])] };
        }
      }
      if (CLOUD_HOME && (patch.signIn?.admins?.length || patch.signIn?.members?.length)) {
        return json(res, 403, { ...userError("serverError.cloud.personal"), code: "cloud_personal" });
      }
      // Saved, it would be overruled by the environment at once: say so instead of answering 200 with nothing changed.
      const signInPinned = signInEnvRefusal(patch.signIn);
      if (signInPinned) return json(res, 409, { error: signInPinned, code: "signin_env" });
      if (patch.newBotDefaults) {
        if (patch.newBotDefaults.profile.modelSelection) {
          const checked = checkedModelSelection(patch.newBotDefaults.profile.modelSelection);
          if (!checked.ok) return json(res, checked.status, refusalBody(checked));
          patch.newBotDefaults.profile.modelSelection = checked.selection;
        }
        for (const skill of patch.newBotDefaults.skills) {
          const parsed = parseSkillMd(skill.text);
          if ("error" in parsed || parsed.name !== skill.name) return json(res, 400, { error: "Skill name does not match its contents" });
        }
      }
      if (patch.automaticRecovery?.enabled) {
        const checked = checkedModelSelection(patch.automaticRecovery.backup, undefined, true);
        if (!checked.ok) return json(res, checked.status, refusalBody(checked));
        const target = registry.get(checked.selection.instanceId)!;
        if (!target.enabled) return json(res, 400, { error: "Enable the backup engine before selecting it for recovery." });
        const refusal = policyModelRefusal(target);
        if (refusal) return json(res, 403, { error: refusal, code: "managed_policy" });
        patch.automaticRecovery.backup = checked.selection;
      }
      if (!Object.keys(patch).length) return json(res, 400, { error: "nothing to save" });
      if (patch.decider) {
        const planned = deciderSavePatch(patch.decider, cfg.decider, { included: deciderIncludedHere(), shared: deciderSharedKeyUsable(cfg) });
        if (!planned.ok) return json(res, 400, refusalBody(planned));
        patch.decider = planned.patch;
      }
      const changingVoiceProvider = patch.tts?.provider !== undefined
        && patch.tts.provider !== tts.voiceProvider(cfg);
      if (changingVoiceProvider && patch.tts?.voice === undefined) {
        // Voice ids are provider-owned: never carry one from one catalog into another.
        patch.tts = { ...patch.tts, voice: "" };
      }
      if (changingVoiceProvider && patch.tts?.model === undefined) patch.tts = { ...patch.tts, model: "" };
      if (providerConfigBusy.get()) return json(res, 409, { error: "provider settings are already being updated" });
      if (patch.browserProfiles !== undefined && body.expectedBrowserProfiles !== undefined) {
        const current = (cfg.browserProfiles ?? []).map(({ id, name, browser }) => ({ id, name, ...(browser ? { browser } : {}) }));
        if (JSON.stringify(body.expectedBrowserProfiles) !== JSON.stringify(current)) {
          return json(res, 409, { error: "Browser profiles changed in another window. Review the refreshed list and try again." });
        }
      }
      const disablingBuiltInBrowser = patch.features?.browser === false && builtInBrowserEnabled(cfg);
      const switchingBrowserEngine = patch.browserEngine?.engine !== undefined && patch.browserEngine.engine !== browserEngineKind(cfg);
      const removedBrowserProfileIds = patch.browserProfiles === undefined
        ? []
        : (cfg.browserProfiles ?? [])
            .map((profile) => profile.id)
            .filter((id) => !patch.browserProfiles!.some((profile) => profile.id === id));
      const browserChoiceChanged = (patch.browserProfiles ?? []).filter((profile) => {
        const current = cfg.browserProfiles?.find((candidate) => candidate.id === profile.id);
        return current !== undefined && (current.browser ?? null) !== (profile.browser ?? null);
      }).map((profile) => profile.id);
      const profileControlConflict = () => removedBrowserProfileIds.some((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        return target && browserRuntime.heldBy(browserSessionId("", target.partitionId));
      });
      if (profileControlConflict()) return json(res, 409, { error: "Release browser control before deleting its profile." });
      if (browserChoiceChanged.some((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        return target && browserRuntime.heldBy(browserSessionId("", target.partitionId));
      })) return json(res, 409, { error: "Release browser control before changing its browser." });
      if (patch.browserProfiles !== undefined) {
        const currentProfiles = new Map((cfg.browserProfiles ?? []).map((profile) => [profile.id, profile]));
        const nextProfiles = patch.browserProfiles.map((profile) => {
          const partitionId = currentProfiles.get(profile.id)?.partitionId;
          return partitionId ? { ...profile, partitionId } : profile;
        });
        const routingConflict = browserProfileReplacementConflict(cfg.browserProfiles ?? [], nextProfiles);
        if (routingConflict) return json(res, 409, { error: routingConflict });
        const currentIds = new Set((cfg.browserProfiles ?? []).map((profile) => profile.id));
        const pendingReuse = patch.browserProfiles.find(
          (profile) => !currentIds.has(profile.id) && browserCleanup.hasPendingProfile(profile.id),
        );
        if (pendingReuse) {
          return json(res, 409, {
            error: `the previous “${pendingReuse.name}” browser session is still being erased — wait before reusing it`,
          });
        }
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
      }
      const currentVpsAlias = vpsSshAlias(cfg);
      const nextVpsAlias = patch.vps === undefined
        ? currentVpsAlias
        : vpsSshAlias({ ...cfg, vps: patch.vps });
      const changingVpsAlias = patch.vps !== undefined && nextVpsAlias !== currentVpsAlias;
      const transitioningProviders: RemoteComputerProvider[] = changingVpsAlias ? ["vps"] : [];
      providerConfigBusy.set(true);
      const changingLocalVmMode = patch.localVm?.mode !== undefined && patch.localVm.mode !== localVmMode(cfg);
      if (changingLocalVmMode) localVmModeChangeBusy.set(true);
      try {
        for (const provider of transitioningProviders) {
          const conflict = providerOperationConflict(provider);
          if (conflict) return json(res, 409, { error: conflict });
        }
        for (const provider of transitioningProviders) computerProviderConfigTransitions.add(provider);

        if (changingVpsAlias && currentVpsAlias) {
          const inventory = await vps.listManagedVpsComputers(
            { vps: { sshAlias: currentVpsAlias } },
            managedComputerOwners(),
          );
          if (!inventory.available) {
            return json(res, 503, {
              error: `${inventory.problem ?? "VPS computer inventory is unavailable"}. Keep the current SSH config alias and retry`,
            });
          }
          const resourceError = vpsAliasResourceChangeError(inventory.instances.length);
          if (resourceError) return json(res, 409, { error: resourceError });
        }

        if (changingLocalVmMode) {
          if (localVmActiveThreads.size > 0 || localVmLifecycleBusy.size > 0 || localVmImageBusy.get()) {
            return json(res, 409, { error: "stop Local VM turns and setup actions before changing the Local VM isolation mode" });
          }
          if (localVmMode(cfg) === "per-bot" && patch.localVm?.mode === "shared") {
            const existing = await perBotLocalVmCountForModeChange();
            if (existing === null) {
              return json(res, 409, {
                error: "start the container runtime and delete every per-bot VM before switching to shared mode",
              });
            }
            if (existing > 0) {
              return json(res, 409, {
                error: `delete the ${existing} per-bot Local VM${existing === 1 ? "" : "s"} before switching to shared mode`,
              });
            }
          }
        }
      const postizRefusal = await postiz?.configCheck(patch);
      if (postizRefusal) return json(res, postizRefusal.status, { error: postizRefusal.error, code: postizRefusal.code, ...userErrorFields(postizRefusal) });
      // Validated against each voice provider's own credential, so no service is ever sent another's key.
      const newTts = patch.tts;
      if (newTts?.key?.trim()) {
        const check = await tts.verifyKey("elevenlabs", newTts.key.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      if (newTts?.fishKey?.trim()) {
        const check = await tts.verifyKey("fish", newTts.fishKey.trim());
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      if (newTts?.geminiKey !== undefined) newTts.geminiKey = newTts.geminiKey.trim();
      if (newTts?.geminiKey) {
        const check = await tts.verifyKey("gemini", newTts.geminiKey);
        if (!check.ok) return json(res, 400, { error: check.message });
      }
      const deciderKey = patch.decider ? deciderPatchKey(patch.decider, cfg.decider) : null;
      if (deciderKey) {
        const check = await decider.testKey(deciderKey.check);
        if (!check.ok && check.reason === "rejected") {
          return json(res, 400, { ...userError(DECIDER_KEY_ERROR[deciderKey.provider]), code: "decider_rejected" });
        }
      }
      if (patch.browserProfiles !== undefined) {
        // Revalidated: the awaits above let a turn claim a profile. No awaits from here through the save.
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        const activeReference = store.bots.find(
          (bot) => bot.busy && bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile),
        );
        if (activeReference) {
          return json(res, 409, {
            error: `stop ${activeReference.name}'s turn before removing its browser profile`,
          });
        }
        const switching = store.bots.find((bot) => bot.busy && bot.browserProfile && browserChoiceChanged.includes(bot.browserProfile));
        if (switching) return json(res, 409, { error: `stop ${switching.name}'s turn before changing its browser` });
      }
      const browsing = switchingBrowserEngine ? store.bots.find((bot) => bot.busy && bot.browser !== false) : undefined;
      if (browsing) return json(res, 409, { error: `stop ${browsing.name}'s turn before switching the browser` });
      // Observed again after the awaits: catches an operation that already held a claim.
      for (const provider of transitioningProviders) {
        const conflict = providerOperationConflict(provider);
        if (conflict) return json(res, 409, { error: conflict });
      }
      // Only the named keys change; merged with no await before the save.
      const browserCleanupRequests: BrowserCleanupRequest[] = [];
      if (profileControlConflict()) return json(res, 409, { error: "Release browser control before deleting its profile." });
      try {
        for (const profileId of removedBrowserProfileIds) {
          const target = browserProfilePartitionTarget(cfg, profileId);
          if (!target) throw new Error(`browser profile cleanup target “${profileId}” is unavailable`);
          browserCleanupRequests.push(
            browserCleanup.prepare("profile", target.profileId, target.partitionId),
          );
        }
      } catch (error) {
        for (const request of browserCleanupRequests) browserCleanup.abort(request);
        throw error;
      }
      const resetKeys = PROVIDER_KEY_KINDS.flatMap((kind) => {
        const next = patch[kind]?.key;
        return next === undefined ? [] : [cfg[kind]?.key, next];
      });
      const engineForSwitch = browserEngineStatus();
      const browsersToClose = browserChoiceChanged.flatMap((id) => {
        const target = browserProfilePartitionTarget(cfg, id);
        if (!target) return [];
        const session = browserSessionId("", target.partitionId);
        const spec = usedBrowserSessions.get(session) ?? (engineForSwitch.kind === "ready" ? browserSessionSpec(engineForSwitch.binaryPath, session, id) : null);
        return spec ? [{ session, spec }] : [];
      });
      let configWriteCommitted = false;
      const enginesBefore = engineLaunches(providerConfigs());
      const externalSecretStorage = url.searchParams.get("secretStorage") === "external";
      try {
        if (patch.live) patch.live = liveSavePatch(cfg.live, patch.live);
        // Before the provider commit, so a failed write never leaves a foreign voice id to speak.
        if (changingVoiceProvider) store.clearVoiceSelections();
        if (externalSecretStorage) {
          // Supplied credentials are already in the OS-encrypted store: tombstone them so no older plaintext survives the merge.
          const persisted = structuredClone(patch);
          if (persisted.openai?.key !== undefined) persisted.openai.key = "";
          if (persisted.openrouter?.key !== undefined) persisted.openrouter.key = "";
          if (persisted.tts?.key !== undefined) persisted.tts.key = "";
          if (persisted.tts?.fishKey !== undefined) persisted.tts.fishKey = "";
          if (persisted.tts?.geminiKey !== undefined) persisted.tts.geminiKey = "";
          if (persisted.decider?.key !== undefined) persisted.decider.key = "";
          if (persisted.decider?.openrouterKey !== undefined) persisted.decider.openrouterKey = "";
          if (persisted.decider?.workersAiToken !== undefined) persisted.decider.workersAiToken = "";
          if (persisted.imageGen?.key !== undefined) persisted.imageGen.key = "";
          if (persisted.imageGen?.customApiKey !== undefined) persisted.imageGen.customApiKey = "";
          if (persisted.imageGen?.geminiKey !== undefined) persisted.imageGen.geminiKey = "";
          if (persisted.live?.key !== undefined) persisted.live.key = "";
          if (persisted.treg?.key !== undefined) persisted.treg.key = "";
          if (persisted.postiz?.key !== undefined) persisted.postiz.key = "";
          saveConfig(persisted);
          configWriteCommitted = true;
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        } else {
          saveConfig(patch);
          configWriteCommitted = true;
          // loadConfig prefers env over the file for credentials, so the env must follow the save.
          syncCredentialEnv(patch);
          Object.assign(cfg, loadConfig());
        }
      } catch (error) {
        if (configWriteCommitted) {
          for (const request of browserCleanupRequests) {
            const committed = browserCleanup.commit(request);
            void browserCleanup.ensure(committed);
          }
        } else {
          for (const request of browserCleanupRequests) browserCleanup.abort(request);
        }
        throw error;
      }
      for (const key of resetKeys) if (key) forgetKey(key);
      postiz?.configSaved(patch);
      // A saved key reaches an engine through the environment its status read uses, often with no reload.
      registry.forgetSnapshots();
      if (patch.localVm?.idleTimeoutMinutes !== undefined) {
        for (const idle of localVmIdles.values()) idle.setIdleMs(localVmIdleMs());
      }
      let browserReferenceCleanupError: unknown = null;
      if (patch.signIn !== undefined) sessions.revalidateEmailSessions();
      if (!lendingEnabled()) {
        sharedComputers.close();
        sharedComputerControl.close();
      }
      if (disablingBuiltInBrowser) browserLive.closeAll();
      if (switchingBrowserEngine) browserEngineSwitched();
      for (const request of browserCleanupRequests) {
        if (request.kind === "profile") browserLive.closeForSession(browserSessionId("", request.partitionId));
      }
      for (const { session, spec } of browsersToClose) {
        browserLive.closeForSession(session);
        usedBrowserSessions.delete(session);
        void closeBrowser(session, spec).then((closed) => {
          if (!closed) console.warn(`browser ${session}: could not close it after its browser changed; the next turn may still use the old one`);
        });
      }
      if (patch.browserProfiles !== undefined) {
        const retained = new Set(patch.browserProfiles.map((profile) => profile.id));
        try {
          for (const bot of store.bots) {
            if (bot.browserProfile && bot.browserProfile !== "guest" && !retained.has(bot.browserProfile)) {
              store.patchBot(bot.id, { browserProfile: undefined });
            }
          }
        } catch (error) {
          // Config is already durable: this failure must not skip revocation and reload below.
          browserReferenceCleanupError = error;
        }
      }
      const changedEngines = new Set(changedInstanceIds(enginesBefore, engineLaunches(providerConfigs())));
      // Revoked before any await: a changed engine's old children are invalid at once.
      revokeEngineCapabilities(changedEngines);
      // Commit failures wait until every mandatory effect has run: no journal failure may leave a bearer or stale engines active.
      const finalized = await finalizeBrowserCleanupMutation({
        requests: browserCleanupRequests,
        referenceError: browserReferenceCleanupError,
        commit: (request) => browserCleanup.commit(request),
        ensure: (request) => browserCleanup.ensure(request),
        mandatory: async () => {
          let mandatoryError: unknown = null;
          if (disablingBuiltInBrowser) {
            try {
            } catch (error) {
              mandatoryError = error;
            }
          }
          if (changedEngines.size > 0) {
            try {
              await reloadProviders(enginesBefore);
            } catch (error) {
              if (!mandatoryError) mandatoryError = error;
            }
          }
          const status = configStatus();
          broadcast({ kind: "config", ...status });
          if (patch.threads !== undefined) {
            drainQueuedSends();
          }
          if (mandatoryError) throw mandatoryError;
          return status;
        },
      });
      // Asserted after every mandatory post-commit effect, so the runtime matches the config even on a 503.
      requireBrowserCleanupAcknowledged(
        finalized.acknowledgements.every(Boolean),
        removedBrowserProfileIds.length === 1 ? "The browser profile" : "The browser profiles",
      );
      return json(res, 200, configForAccess(finalized.value, auth));
      } finally {
        for (const provider of transitioningProviders) computerProviderConfigTransitions.delete(provider);
        if (changingLocalVmMode) localVmModeChangeBusy.set(false);
        providerConfigBusy.set(false);
      }
    }
    return PASS;
  };
}
