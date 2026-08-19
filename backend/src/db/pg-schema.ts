// PostgreSQL schema mirror, derived at runtime from the canonical sqlite
// schema (db/schema-sqlite.ts). Both backends therefore share one source of
// truth: adding a column to the sqlite definition automatically mirrors it
// here, and the drift check in tests/db/schema-parity.test.ts guards the
// mapping.
//
// drizzle encodes the dialect into table/column objects, so the active
// backend needs real pg-core tables (sqlite boolean columns map booleans to
// 0/1 at expression-build time, which postgres rejects). db/schema.ts
// re-exports this module's tables (cast to the sqlite types routes are
// compiled against) when the postgres driver is active.
//
// AUTO-GENERATED export list; regenerate with:
//   bun run scripts/regenerate-pg-schema-exports.ts
import * as sqliteSchema from "./schema-sqlite";
import { buildPgSchema } from "./pg-convert";

const pg = buildPgSchema(sqliteSchema);

const dbNameOf = (table: object): string =>
  String((table as Record<PropertyKey, unknown>)[Symbol.for("drizzle:Name")]);

export const adminGeneralSettings = pg[dbNameOf(sqliteSchema.adminGeneralSettings)];
export const adminOpaVersions = pg[dbNameOf(sqliteSchema.adminOpaVersions)];
export const adminSentinelVersions = pg[dbNameOf(sqliteSchema.adminSentinelVersions)];
export const adminSettings = pg[dbNameOf(sqliteSchema.adminSettings)];
export const adminTerraformVersions = pg[dbNameOf(sqliteSchema.adminTerraformVersions)];
export const agentForwardedRequests = pg[dbNameOf(sqliteSchema.agentForwardedRequests)];
export const agentJobs = pg[dbNameOf(sqliteSchema.agentJobs)];
export const agentPoolAllowedProjects = pg[dbNameOf(sqliteSchema.agentPoolAllowedProjects)];
export const agentPoolAllowedWorkspaces = pg[dbNameOf(sqliteSchema.agentPoolAllowedWorkspaces)];
export const agentPoolExcludedWorkspaces = pg[dbNameOf(sqliteSchema.agentPoolExcludedWorkspaces)];
export const agentPoolTokens = pg[dbNameOf(sqliteSchema.agentPoolTokens)];
export const agentPools = pg[dbNameOf(sqliteSchema.agentPools)];
export const agents = pg[dbNameOf(sqliteSchema.agents)];
export const apiTokens = pg[dbNameOf(sqliteSchema.apiTokens)];
export const assessmentCheckResults = pg[dbNameOf(sqliteSchema.assessmentCheckResults)];
export const assessmentResults = pg[dbNameOf(sqliteSchema.assessmentResults)];
export const auditLogs = pg[dbNameOf(sqliteSchema.auditLogs)];
export const changeRequests = pg[dbNameOf(sqliteSchema.changeRequests)];
export const cidrRangeListAgentPools = pg[dbNameOf(sqliteSchema.cidrRangeListAgentPools)];
export const cidrRangeLists = pg[dbNameOf(sqliteSchema.cidrRangeLists)];
export const cidrRanges = pg[dbNameOf(sqliteSchema.cidrRanges)];
export const configurationVersions = pg[dbNameOf(sqliteSchema.configurationVersions)];
export const controlPlaneNodes = pg[dbNameOf(sqliteSchema.controlPlaneNodes)];
export const dataRetentionPolicies = pg[dbNameOf(sqliteSchema.dataRetentionPolicies)];
export const durableJobs = pg[dbNameOf(sqliteSchema.durableJobs)];
export const explorerCatalogItems = pg[dbNameOf(sqliteSchema.explorerCatalogItems)];
export const explorerCatalogMemberships = pg[dbNameOf(sqliteSchema.explorerCatalogMemberships)];
export const explorerSavedQueries = pg[dbNameOf(sqliteSchema.explorerSavedQueries)];
export const explorerWorkspaceInventory = pg[dbNameOf(sqliteSchema.explorerWorkspaceInventory)];
export const githubAppInstallations = pg[dbNameOf(sqliteSchema.githubAppInstallations)];
export const githubWebhookDeliveries = pg[dbNameOf(sqliteSchema.githubWebhookDeliveries)];
export const hyokConfigurations = pg[dbNameOf(sqliteSchema.hyokConfigurations)];
export const hyokCustomerKeyVersions = pg[dbNameOf(sqliteSchema.hyokCustomerKeyVersions)];
export const logs = pg[dbNameOf(sqliteSchema.logs)];
export const moduleTestConfigurationVersions = pg[dbNameOf(sqliteSchema.moduleTestConfigurationVersions)];
export const moduleTestConfigurations = pg[dbNameOf(sqliteSchema.moduleTestConfigurations)];
export const moduleTestResults = pg[dbNameOf(sqliteSchema.moduleTestResults)];
export const moduleTestRuns = pg[dbNameOf(sqliteSchema.moduleTestRuns)];
export const noCodeModules = pg[dbNameOf(sqliteSchema.noCodeModules)];
export const noCodeVariableOptions = pg[dbNameOf(sqliteSchema.noCodeVariableOptions)];
export const noCodeWorkspaceConfigurations = pg[dbNameOf(sqliteSchema.noCodeWorkspaceConfigurations)];
export const notificationConfigurationWorkspaceExclusions = pg[dbNameOf(sqliteSchema.notificationConfigurationWorkspaceExclusions)];
export const notificationConfigurations = pg[dbNameOf(sqliteSchema.notificationConfigurations)];
export const notificationWorkspaceCounters = pg[dbNameOf(sqliteSchema.notificationWorkspaceCounters)];
export const oauthClientProjects = pg[dbNameOf(sqliteSchema.oauthClientProjects)];
export const oauthClients = pg[dbNameOf(sqliteSchema.oauthClients)];
export const oauthDeviceCodes = pg[dbNameOf(sqliteSchema.oauthDeviceCodes)];
export const oauthHandshakeStates = pg[dbNameOf(sqliteSchema.oauthHandshakeStates)];
export const oauthTokens = pg[dbNameOf(sqliteSchema.oauthTokens)];
export const oidcConfigs = pg[dbNameOf(sqliteSchema.oidcConfigs)];
export const orgTokenTTLPolicies = pg[dbNameOf(sqliteSchema.orgTokenTTLPolicies)];
export const organizationDataRetentionPolicies = pg[dbNameOf(sqliteSchema.organizationDataRetentionPolicies)];
export const organizationMembershipRoles = pg[dbNameOf(sqliteSchema.organizationMembershipRoles)];
export const organizationMemberships = pg[dbNameOf(sqliteSchema.organizationMemberships)];
export const organizationRoles = pg[dbNameOf(sqliteSchema.organizationRoles)];
export const organizations = pg[dbNameOf(sqliteSchema.organizations)];
export const planExports = pg[dbNameOf(sqliteSchema.planExports)];
export const policies = pg[dbNameOf(sqliteSchema.policies)];
export const policyChecks = pg[dbNameOf(sqliteSchema.policyChecks)];
export const policyEvaluations = pg[dbNameOf(sqliteSchema.policyEvaluations)];
export const policySetExclusions = pg[dbNameOf(sqliteSchema.policySetExclusions)];
export const policySetOutcomes = pg[dbNameOf(sqliteSchema.policySetOutcomes)];
export const policySetParameters = pg[dbNameOf(sqliteSchema.policySetParameters)];
export const policySetProjectExclusions = pg[dbNameOf(sqliteSchema.policySetProjectExclusions)];
export const policySetProjects = pg[dbNameOf(sqliteSchema.policySetProjects)];
export const policySetTagSelectors = pg[dbNameOf(sqliteSchema.policySetTagSelectors)];
export const policySetVersions = pg[dbNameOf(sqliteSchema.policySetVersions)];
export const policySetWorkspaces = pg[dbNameOf(sqliteSchema.policySetWorkspaces)];
export const policySets = pg[dbNameOf(sqliteSchema.policySets)];
export const projectTags = pg[dbNameOf(sqliteSchema.projectTags)];
export const projects = pg[dbNameOf(sqliteSchema.projects)];
export const providerSets = pg[dbNameOf(sqliteSchema.providerSets)];
export const queryRuns = pg[dbNameOf(sqliteSchema.queryRuns)];
export const refreshSessions = pg[dbNameOf(sqliteSchema.refreshSessions)];
export const registryGpgKeys = pg[dbNameOf(sqliteSchema.registryGpgKeys)];
export const registryModuleVersions = pg[dbNameOf(sqliteSchema.registryModuleVersions)];
export const registryModules = pg[dbNameOf(sqliteSchema.registryModules)];
export const registryPartnerships = pg[dbNameOf(sqliteSchema.registryPartnerships)];
export const registryProviderPlatforms = pg[dbNameOf(sqliteSchema.registryProviderPlatforms)];
export const registryProviderVersions = pg[dbNameOf(sqliteSchema.registryProviderVersions)];
export const registryProviders = pg[dbNameOf(sqliteSchema.registryProviders)];
export const remoteStateConsumers = pg[dbNameOf(sqliteSchema.remoteStateConsumers)];
export const reservedTagKeys = pg[dbNameOf(sqliteSchema.reservedTagKeys)];
export const runComments = pg[dbNameOf(sqliteSchema.runComments)];
export const runExplanations = pg[dbNameOf(sqliteSchema.runExplanations)];
export const runTaskResults = pg[dbNameOf(sqliteSchema.runTaskResults)];
export const runTasks = pg[dbNameOf(sqliteSchema.runTasks)];
export const runTokens = pg[dbNameOf(sqliteSchema.runTokens)];
export const runTriggers = pg[dbNameOf(sqliteSchema.runTriggers)];
export const runs = pg[dbNameOf(sqliteSchema.runs)];
export const samlSettings = pg[dbNameOf(sqliteSchema.samlSettings)];
export const scimGroupMemberships = pg[dbNameOf(sqliteSchema.scimGroupMemberships)];
export const scimGroups = pg[dbNameOf(sqliteSchema.scimGroups)];
export const scimSettings = pg[dbNameOf(sqliteSchema.scimSettings)];
export const scimTokens = pg[dbNameOf(sqliteSchema.scimTokens)];
export const scimUserIdentities = pg[dbNameOf(sqliteSchema.scimUserIdentities)];
export const siteDataRetentionPolicies = pg[dbNameOf(sqliteSchema.siteDataRetentionPolicies)];
export const sshKeys = pg[dbNameOf(sqliteSchema.sshKeys)];
export const ssoChallenges = pg[dbNameOf(sqliteSchema.ssoChallenges)];
export const stackAgentJobs = pg[dbNameOf(sqliteSchema.stackAgentJobs)];
export const stackRecords = pg[dbNameOf(sqliteSchema.stackRecords)];
export const stackStateLocks = pg[dbNameOf(sqliteSchema.stackStateLocks)];
export const stackVariableSets = pg[dbNameOf(sqliteSchema.stackVariableSets)];
export const stacks = pg[dbNameOf(sqliteSchema.stacks)];
export const stateVersions = pg[dbNameOf(sqliteSchema.stateVersions)];
export const supportBundleRequests = pg[dbNameOf(sqliteSchema.supportBundleRequests)];
export const systemApiTokens = pg[dbNameOf(sqliteSchema.systemApiTokens)];
export const taskStages = pg[dbNameOf(sqliteSchema.taskStages)];
export const teamMemberships = pg[dbNameOf(sqliteSchema.teamMemberships)];
export const teamProjects = pg[dbNameOf(sqliteSchema.teamProjects)];
export const teamScimGroupMappings = pg[dbNameOf(sqliteSchema.teamScimGroupMappings)];
export const teamWorkspaces = pg[dbNameOf(sqliteSchema.teamWorkspaces)];
export const teams = pg[dbNameOf(sqliteSchema.teams)];
export const testVariables = pg[dbNameOf(sqliteSchema.testVariables)];
export const user2FA = pg[dbNameOf(sqliteSchema.user2FA)];
export const users = pg[dbNameOf(sqliteSchema.users)];
export const variableSetProjects = pg[dbNameOf(sqliteSchema.variableSetProjects)];
export const variableSetVariables = pg[dbNameOf(sqliteSchema.variableSetVariables)];
export const variableSetWorkspaces = pg[dbNameOf(sqliteSchema.variableSetWorkspaces)];
export const variableSets = pg[dbNameOf(sqliteSchema.variableSets)];
export const workloadIdentityKeys = pg[dbNameOf(sqliteSchema.workloadIdentityKeys)];
export const workloadIdentityLeases = pg[dbNameOf(sqliteSchema.workloadIdentityLeases)];
export const workloadIdentityTokens = pg[dbNameOf(sqliteSchema.workloadIdentityTokens)];
export const workspaceRunTasks = pg[dbNameOf(sqliteSchema.workspaceRunTasks)];
export const workspaceTags = pg[dbNameOf(sqliteSchema.workspaceTags)];
export const workspaceTransfers = pg[dbNameOf(sqliteSchema.workspaceTransfers)];
export const workspaceVariables = pg[dbNameOf(sqliteSchema.workspaceVariables)];
export const workspaces = pg[dbNameOf(sqliteSchema.workspaces)];
