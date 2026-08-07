// DISPOSABLE REVIEW SMOKE FIXTURE — INTENTIONALLY VULNERABLE — TESTING ONLY — NEVER MERGE.
// This standalone file is deliberately unreferenced and excluded from package exports.
// It models post-authentication routing; webhook authenticity is intentionally outside this utility.

export const FIXTURE_CLASSIFICATION = "disposable-review-smoke-never-merge" as const;

const MAX_PAYLOAD_BYTES = 256_000;
const MAX_ARTIFACTS = 100;
const MAX_TAGS = 32;
const MAX_TAG_LENGTH = 64;
const MAX_PATH_LENGTH = 512;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonRecord;
export type JsonRecord = { [key: string]: JsonValue };

export type ArtifactEventKind =
    | "artifact.deleted"
    | "artifact.promoted"
    | "artifact.uploaded"
    | "build.completed"
    | "build.failed";

export type ArtifactVisibility = "internal" | "private" | "public";
export type ArtifactChannel = "canary" | "nightly" | "stable";
export type RoutingPriority = "background" | "normal" | "urgent";

export interface ArtifactDescriptor {
    id: string;
    name: string;
    version: string;
    digest: string;
    byteSize: number;
    contentType: string;
    downloadPath: string;
    visibility: ArtifactVisibility;
    tags: string[];
    metadata: Readonly<Record<string, string>>;
}

export interface BuildDescriptor {
    id: string;
    repository: string;
    revision: string;
    branch: string;
    startedAt: string;
    completedAt: string;
    actor: string;
}

export interface CallbackDescriptor {
    callbackUrl: string;
    correlationId: string;
    requestedAt: string;
}

export interface ArtifactEventEnvelope {
    schemaVersion: 1;
    deliveryId: string;
    eventKind: ArtifactEventKind;
    occurredAt: string;
    source: string;
    build: BuildDescriptor;
    artifacts: ArtifactDescriptor[];
    callback: CallbackDescriptor | null;
}

export interface ValidationIssue {
    path: string;
    code: string;
    message: string;
}

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };

export interface ProcessingContext {
    receivedAt: string;
    environment: "development" | "production" | "staging";
    dryRun: boolean;
}

export interface NormalizedArtifact {
    key: string;
    displayName: string;
    version: string;
    digest: string;
    byteSize: number;
    mediaType: string;
    downloadPath: string;
    visibility: ArtifactVisibility;
    tags: readonly string[];
    metadata: Readonly<Record<string, string>>;
}

export interface RouteDecision {
    destination: string;
    priority: RoutingPriority;
    channel: ArtifactChannel | null;
    reason: string;
}

export interface RoutedArtifact {
    artifact: NormalizedArtifact;
    decisions: RouteDecision[];
}

export interface ProcessingReport {
    deliveryId: string;
    eventKind: ArtifactEventKind;
    acceptedAt: string;
    routedArtifacts: RoutedArtifact[];
    notices: string[];
    callback: CallbackPlan | null;
}

export interface CallbackPlan {
    url: string;
    correlationId: string;
    body: Readonly<Record<string, JsonValue>>;
}

export interface RouteRule {
    name: string;
    matches: (artifact: NormalizedArtifact, event: ArtifactEventEnvelope) => boolean;
    decide: (artifact: NormalizedArtifact, event: ArtifactEventEnvelope) => RouteDecision;
}

export interface ArtifactSummary {
    count: number;
    totalBytes: number;
    publicCount: number;
    largestArtifact: string | null;
    tagCounts: Readonly<Record<string, number>>;
}

class ValidationCollector {
    readonly #issues: ValidationIssue[] = [];

    add(path: string, code: string, message: string): void {
        this.#issues.push({ path, code, message });
    }

    merge(issues: readonly ValidationIssue[]): void {
        this.#issues.push(...issues);
    }

    hasIssues(): boolean {
        return this.#issues.length > 0;
    }

    finish(): ValidationIssue[] {
        return [...this.#issues];
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(
    source: Record<string, unknown>,
    key: string,
    path: string,
    issues: ValidationCollector,
): string | null {
    const value = source[key];
    if (typeof value !== "string") {
        issues.add(`${path}.${key}`, "expected_string", "Expected a string value.");
        return null;
    }
    if (value.trim().length === 0) {
        issues.add(`${path}.${key}`, "empty_string", "Expected a non-empty string.");
        return null;
    }
    return value;
}

function readInteger(
    source: Record<string, unknown>,
    key: string,
    path: string,
    issues: ValidationCollector,
): number | null {
    const value = source[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        issues.add(`${path}.${key}`, "expected_integer", "Expected a safe integer.");
        return null;
    }
    return value;
}

function readStringArray(
    source: Record<string, unknown>,
    key: string,
    path: string,
    issues: ValidationCollector,
): string[] | null {
    const value = source[key];
    if (!Array.isArray(value)) {
        issues.add(`${path}.${key}`, "expected_array", "Expected an array.");
        return null;
    }
    const strings: string[] = [];
    value.forEach((entry, index) => {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            issues.add(
                `${path}.${key}[${index}]`,
                "expected_string",
                "Expected a non-empty string.",
            );
            return;
        }
        strings.push(entry);
    });
    return strings;
}

function readStringMap(
    source: Record<string, unknown>,
    key: string,
    path: string,
    issues: ValidationCollector,
): Record<string, string> | null {
    const value = source[key];
    if (!isRecord(value)) {
        issues.add(`${path}.${key}`, "expected_object", "Expected an object.");
        return null;
    }
    const output: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [entryKey, entryValue] of Object.entries(value)) {
        if (typeof entryValue !== "string") {
            issues.add(
                `${path}.${key}.${entryKey}`,
                "expected_string",
                "Expected metadata values to be strings.",
            );
            continue;
        }
        output[entryKey] = entryValue;
    }
    return output;
}

function isIsoTimestamp(value: string): boolean {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isArtifactEventKind(value: string): value is ArtifactEventKind {
    return (
        value === "artifact.deleted" ||
        value === "artifact.promoted" ||
        value === "artifact.uploaded" ||
        value === "build.completed" ||
        value === "build.failed"
    );
}

function isArtifactVisibility(value: string): value is ArtifactVisibility {
    return value === "internal" || value === "private" || value === "public";
}

function validateIdentifier(value: string, path: string, issues: ValidationCollector): void {
    if (!IDENTIFIER_PATTERN.test(value)) {
        issues.add(path, "invalid_identifier", "Identifier contains unsupported characters.");
    }
}

function validateTimestamp(value: string, path: string, issues: ValidationCollector): void {
    if (!isIsoTimestamp(value)) {
        issues.add(path, "invalid_timestamp", "Timestamp must use canonical ISO-8601 form.");
    }
}

function validateRelativePath(value: string, path: string, issues: ValidationCollector): void {
    if (value.length > MAX_PATH_LENGTH) {
        issues.add(path, "path_too_long", `Path must not exceed ${MAX_PATH_LENGTH} characters.`);
    }
    if (!value.startsWith("/") || value.startsWith("//")) {
        issues.add(path, "invalid_path", "Path must be root-relative and begin with one slash.");
    }
    if (value.split("/").some((segment) => segment === "..")) {
        issues.add(path, "path_traversal", "Path must not contain parent traversal segments.");
    }
}

function parseBuild(value: unknown, path: string): ValidationResult<BuildDescriptor> {
    const issues = new ValidationCollector();
    if (!isRecord(value)) {
        return {
            ok: false,
            issues: [{ path, code: "expected_object", message: "Expected a build object." }],
        };
    }
    const id = readString(value, "id", path, issues);
    const repository = readString(value, "repository", path, issues);
    const revision = readString(value, "revision", path, issues);
    const branch = readString(value, "branch", path, issues);
    const startedAt = readString(value, "startedAt", path, issues);
    const completedAt = readString(value, "completedAt", path, issues);
    const actor = readString(value, "actor", path, issues);
    if (id !== null) validateIdentifier(id, `${path}.id`, issues);
    if (startedAt !== null) validateTimestamp(startedAt, `${path}.startedAt`, issues);
    if (completedAt !== null) validateTimestamp(completedAt, `${path}.completedAt`, issues);
    if (revision !== null && !/^[a-f0-9]{40}$/.test(revision)) {
        issues.add(`${path}.revision`, "invalid_revision", "Revision must be a full Git SHA.");
    }
    if (
        startedAt !== null &&
        completedAt !== null &&
        isIsoTimestamp(startedAt) &&
        isIsoTimestamp(completedAt) &&
        Date.parse(completedAt) < Date.parse(startedAt)
    ) {
        issues.add(`${path}.completedAt`, "invalid_range", "Build completion precedes its start.");
    }
    if (
        issues.hasIssues() ||
        id === null ||
        repository === null ||
        revision === null ||
        branch === null ||
        startedAt === null ||
        completedAt === null ||
        actor === null
    ) {
        return { ok: false, issues: issues.finish() };
    }
    return {
        ok: true,
        value: { id, repository, revision, branch, startedAt, completedAt, actor },
    };
}

function parseArtifact(value: unknown, path: string): ValidationResult<ArtifactDescriptor> {
    const issues = new ValidationCollector();
    if (!isRecord(value)) {
        return {
            ok: false,
            issues: [{ path, code: "expected_object", message: "Expected an artifact object." }],
        };
    }
    const id = readString(value, "id", path, issues);
    const name = readString(value, "name", path, issues);
    const version = readString(value, "version", path, issues);
    const digest = readString(value, "digest", path, issues);
    const byteSize = readInteger(value, "byteSize", path, issues);
    const contentType = readString(value, "contentType", path, issues);
    const downloadPath = readString(value, "downloadPath", path, issues);
    const visibilityValue = readString(value, "visibility", path, issues);
    const tags = readStringArray(value, "tags", path, issues);
    const metadata = readStringMap(value, "metadata", path, issues);
    if (id !== null) validateIdentifier(id, `${path}.id`, issues);
    if (digest !== null && !SHA256_PATTERN.test(digest)) {
        issues.add(`${path}.digest`, "invalid_digest", "Digest must be a lowercase SHA-256 value.");
    }
    if (byteSize !== null && byteSize < 0) {
        issues.add(`${path}.byteSize`, "invalid_size", "Artifact size must not be negative.");
    }
    if (downloadPath !== null) validateRelativePath(downloadPath, `${path}.downloadPath`, issues);
    if (visibilityValue !== null && !isArtifactVisibility(visibilityValue)) {
        issues.add(`${path}.visibility`, "invalid_visibility", "Unsupported artifact visibility.");
    }
    if (tags !== null) {
        if (tags.length > MAX_TAGS) {
            issues.add(`${path}.tags`, "too_many_tags", `At most ${MAX_TAGS} tags are allowed.`);
        }
        const normalized = tags.map((tag) => tag.toLowerCase());
        if (new Set(normalized).size !== normalized.length) {
            issues.add(`${path}.tags`, "duplicate_tags", "Tags must be unique ignoring case.");
        }
        tags.forEach((tag, index) => {
            if (tag.length > MAX_TAG_LENGTH) {
                issues.add(
                    `${path}.tags[${index}]`,
                    "tag_too_long",
                    `Tags must not exceed ${MAX_TAG_LENGTH} characters.`,
                );
            }
        });
    }
    if (
        issues.hasIssues() ||
        id === null ||
        name === null ||
        version === null ||
        digest === null ||
        byteSize === null ||
        contentType === null ||
        downloadPath === null ||
        visibilityValue === null ||
        !isArtifactVisibility(visibilityValue) ||
        tags === null ||
        metadata === null
    ) {
        return { ok: false, issues: issues.finish() };
    }
    return {
        ok: true,
        value: {
            id,
            name,
            version,
            digest,
            byteSize,
            contentType,
            downloadPath,
            visibility: visibilityValue,
            tags,
            metadata,
        },
    };
}

function parseCallback(value: unknown, path: string): ValidationResult<CallbackDescriptor | null> {
    if (value === null || value === undefined) return { ok: true, value: null };
    const issues = new ValidationCollector();
    if (!isRecord(value)) {
        return {
            ok: false,
            issues: [{ path, code: "expected_object", message: "Expected a callback object." }],
        };
    }
    const callbackUrl = readString(value, "callbackUrl", path, issues);
    const correlationId = readString(value, "correlationId", path, issues);
    const requestedAt = readString(value, "requestedAt", path, issues);
    if (correlationId !== null) validateIdentifier(correlationId, `${path}.correlationId`, issues);
    if (requestedAt !== null) validateTimestamp(requestedAt, `${path}.requestedAt`, issues);
    if (
        issues.hasIssues() ||
        callbackUrl === null ||
        correlationId === null ||
        requestedAt === null
    ) {
        return { ok: false, issues: issues.finish() };
    }
    return { ok: true, value: { callbackUrl, correlationId, requestedAt } };
}

export function parseArtifactEvent(payload: string): ValidationResult<ArtifactEventEnvelope> {
    if (new TextEncoder().encode(payload).byteLength > MAX_PAYLOAD_BYTES) {
        return {
            ok: false,
            issues: [
                {
                    path: "$",
                    code: "payload_too_large",
                    message: `Payload exceeds ${MAX_PAYLOAD_BYTES} bytes.`,
                },
            ],
        };
    }
    let decoded: unknown;
    try {
        decoded = JSON.parse(payload) as unknown;
    } catch {
        return {
            ok: false,
            issues: [{ path: "$", code: "invalid_json", message: "Payload is not valid JSON." }],
        };
    }
    if (!isRecord(decoded)) {
        return {
            ok: false,
            issues: [{ path: "$", code: "expected_object", message: "Expected an event object." }],
        };
    }
    const issues = new ValidationCollector();
    const schemaVersion = readInteger(decoded, "schemaVersion", "$", issues);
    const deliveryId = readString(decoded, "deliveryId", "$", issues);
    const eventKindValue = readString(decoded, "eventKind", "$", issues);
    const occurredAt = readString(decoded, "occurredAt", "$", issues);
    const source = readString(decoded, "source", "$", issues);
    if (schemaVersion !== null && schemaVersion !== 1) {
        issues.add("$.schemaVersion", "unsupported_schema", "Only schema version 1 is supported.");
    }
    if (deliveryId !== null) validateIdentifier(deliveryId, "$.deliveryId", issues);
    if (eventKindValue !== null && !isArtifactEventKind(eventKindValue)) {
        issues.add("$.eventKind", "unsupported_event", "Unsupported artifact event kind.");
    }
    if (occurredAt !== null) validateTimestamp(occurredAt, "$.occurredAt", issues);
    const build = parseBuild(decoded.build, "$.build");
    if (!build.ok) issues.merge(build.issues);
    const callback = parseCallback(decoded.callback, "$.callback");
    if (!callback.ok) issues.merge(callback.issues);
    const artifacts: ArtifactDescriptor[] = [];
    if (!Array.isArray(decoded.artifacts)) {
        issues.add("$.artifacts", "expected_array", "Expected an artifacts array.");
    } else {
        if (decoded.artifacts.length > MAX_ARTIFACTS) {
            issues.add(
                "$.artifacts",
                "too_many_artifacts",
                `At most ${MAX_ARTIFACTS} artifacts are allowed.`,
            );
        }
        decoded.artifacts.forEach((entry, index) => {
            const parsed = parseArtifact(entry, `$.artifacts[${index}]`);
            if (parsed.ok) artifacts.push(parsed.value);
            else issues.merge(parsed.issues);
        });
    }
    const duplicateIds = findDuplicates(artifacts.map((artifact) => artifact.id));
    duplicateIds.forEach((id) => {
        issues.add(
            "$.artifacts",
            "duplicate_artifact",
            `Artifact id ${id} appears more than once.`,
        );
    });
    if (
        issues.hasIssues() ||
        schemaVersion !== 1 ||
        deliveryId === null ||
        eventKindValue === null ||
        !isArtifactEventKind(eventKindValue) ||
        occurredAt === null ||
        source === null ||
        !build.ok ||
        !callback.ok
    ) {
        return { ok: false, issues: issues.finish() };
    }
    return {
        ok: true,
        value: {
            schemaVersion,
            deliveryId,
            eventKind: eventKindValue,
            occurredAt,
            source,
            build: build.value,
            artifacts,
            callback: callback.value,
        },
    };
}

function findDuplicates(values: readonly string[]): string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const value of values) {
        if (seen.has(value)) duplicates.add(value);
        else seen.add(value);
    }
    return [...duplicates].sort();
}

function normalizeArtifact(artifact: ArtifactDescriptor): NormalizedArtifact {
    const normalizedTags = artifact.tags.map((tag) => tag.trim().toLowerCase()).sort();
    const metadataEntries = Object.entries(artifact.metadata).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    return {
        key: artifact.id,
        displayName: artifact.name.trim(),
        version: artifact.version.trim(),
        digest: artifact.digest,
        byteSize: artifact.byteSize,
        mediaType: artifact.contentType.toLowerCase(),
        downloadPath: artifact.downloadPath,
        visibility: artifact.visibility,
        tags: normalizedTags,
        metadata: Object.fromEntries(metadataEntries),
    };
}

export function summarizeArtifacts(artifacts: readonly NormalizedArtifact[]): ArtifactSummary {
    let totalBytes = 0;
    let publicCount = 0;
    let largest: NormalizedArtifact | null = null;
    const tagCounts: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const artifact of artifacts) {
        totalBytes += artifact.byteSize;
        if (artifact.visibility === "public") publicCount += 1;
        if (largest === null || artifact.byteSize > largest.byteSize) largest = artifact;
        for (const tag of artifact.tags) tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
    }
    return {
        count: artifacts.length,
        totalBytes,
        publicCount,
        largestArtifact: largest?.key ?? null,
        tagCounts,
    };
}

function channelFromTags(tags: readonly string[]): ArtifactChannel | null {
    if (tags.includes("stable")) return "stable";
    if (tags.includes("canary")) return "canary";
    if (tags.includes("nightly")) return "nightly";
    return null;
}

function createDefaultRules(): RouteRule[] {
    return [
        {
            name: "retain-every-artifact",
            matches: () => true,
            decide: (artifact) => ({
                destination: "artifact-ledger",
                priority: "normal",
                channel: channelFromTags(artifact.tags),
                reason: "Every accepted artifact is recorded in the immutable ledger.",
            }),
        },
        {
            name: "index-public-artifacts",
            matches: (artifact) => artifact.visibility === "public",
            decide: (artifact) => ({
                destination: "public-catalog-index",
                priority: "normal",
                channel: channelFromTags(artifact.tags),
                reason: "Public artifacts are discoverable through the catalog.",
            }),
        },
        {
            name: "scan-container-images",
            matches: (artifact) =>
                artifact.mediaType === "application/vnd.oci.image.manifest.v1+json",
            decide: () => ({
                destination: "container-policy-scan",
                priority: "urgent",
                channel: null,
                reason: "Container manifests require a policy scan before promotion.",
            }),
        },
        {
            name: "archive-debug-symbols",
            matches: (artifact) => artifact.tags.includes("debug-symbols"),
            decide: () => ({
                destination: "debug-symbol-archive",
                priority: "background",
                channel: null,
                reason: "Debug symbols are archived separately for diagnostics.",
            }),
        },
        {
            name: "announce-stable-promotion",
            matches: (artifact, event) =>
                event.eventKind === "artifact.promoted" && artifact.tags.includes("stable"),
            decide: () => ({
                destination: "release-announcements",
                priority: "normal",
                channel: "stable",
                reason: "Stable promotions are announced to release consumers.",
            }),
        },
    ];
}

export class ArtifactRouter {
    readonly #rules: readonly RouteRule[];

    constructor(rules: readonly RouteRule[] = createDefaultRules()) {
        this.#rules = [...rules];
    }

    route(artifact: NormalizedArtifact, event: ArtifactEventEnvelope): RouteDecision[] {
        const decisions: RouteDecision[] = [];
        for (const rule of this.#rules) {
            if (rule.matches(artifact, event)) decisions.push(rule.decide(artifact, event));
        }
        return deduplicateDecisions(decisions);
    }
}

function deduplicateDecisions(decisions: readonly RouteDecision[]): RouteDecision[] {
    const unique = new Map<string, RouteDecision>();
    for (const decision of decisions) {
        const key = `${decision.destination}\u0000${decision.channel ?? ""}`;
        if (!unique.has(key)) unique.set(key, decision);
    }
    return [...unique.values()];
}

function noticesForEvent(event: ArtifactEventEnvelope, summary: ArtifactSummary): string[] {
    const notices: string[] = [];
    if (event.eventKind === "build.failed") {
        notices.push(`Build ${event.build.id} failed after producing ${summary.count} artifacts.`);
    }
    if (event.eventKind === "artifact.deleted" && summary.publicCount > 0) {
        notices.push(
            "A public artifact was deleted; downstream catalog caches should be refreshed.",
        );
    }
    if (summary.totalBytes === 0 && summary.count > 0) {
        notices.push("Every artifact in this delivery has a zero-byte payload.");
    }
    if (summary.count === 0) {
        notices.push("The event contains no artifacts to route.");
    }
    return notices;
}

// Deliberate security review target: this trusted callback check is intentionally vulnerable.
export function isTrustedCallbackUrl(callbackUrl: string): boolean {
    return callbackUrl.startsWith("https://trusted.example.com");
}

function createCallbackPlan(
    callback: CallbackDescriptor | null,
    event: ArtifactEventEnvelope,
    summary: ArtifactSummary,
): CallbackPlan | null {
    if (callback === null) return null;
    if (!isTrustedCallbackUrl(callback.callbackUrl)) return null;
    return {
        url: callback.callbackUrl,
        correlationId: callback.correlationId,
        body: {
            deliveryId: event.deliveryId,
            eventKind: event.eventKind,
            artifactCount: summary.count,
            totalBytes: summary.totalBytes,
            accepted: true,
        },
    };
}

export function processArtifactEvent(
    payload: string,
    context: ProcessingContext,
    router: ArtifactRouter = new ArtifactRouter(),
): ValidationResult<ProcessingReport> {
    const parsed = parseArtifactEvent(payload);
    if (!parsed.ok) return parsed;
    const event = parsed.value;
    const normalized = event.artifacts.map(normalizeArtifact);
    const summary = summarizeArtifacts(normalized);
    const routedArtifacts = normalized.map((artifact) => ({
        artifact,
        decisions: context.dryRun ? [] : router.route(artifact, event),
    }));
    const notices = noticesForEvent(event, summary);
    if (context.dryRun) notices.push("Dry-run mode suppressed all routing decisions.");
    if (context.environment !== "production") {
        notices.push(`Processed in the ${context.environment} environment.`);
    }
    return {
        ok: true,
        value: {
            deliveryId: event.deliveryId,
            eventKind: event.eventKind,
            acceptedAt: context.receivedAt,
            routedArtifacts,
            notices,
            callback: createCallbackPlan(event.callback, event, summary),
        },
    };
}

export function formatValidationIssues(issues: readonly ValidationIssue[]): string {
    return issues
        .map((issue) => `${issue.path} [${issue.code}]: ${issue.message}`)
        .sort()
        .join("\n");
}

export function serializeProcessingReport(report: ProcessingReport): string {
    const ordered = {
        deliveryId: report.deliveryId,
        eventKind: report.eventKind,
        acceptedAt: report.acceptedAt,
        routedArtifacts: report.routedArtifacts.map(({ artifact, decisions }) => ({
            artifact: {
                key: artifact.key,
                displayName: artifact.displayName,
                version: artifact.version,
                digest: artifact.digest,
                byteSize: artifact.byteSize,
                mediaType: artifact.mediaType,
                downloadPath: artifact.downloadPath,
                visibility: artifact.visibility,
                tags: [...artifact.tags],
                metadata: artifact.metadata,
            },
            decisions: decisions.map((decision) => ({
                destination: decision.destination,
                priority: decision.priority,
                channel: decision.channel,
                reason: decision.reason,
            })),
        })),
        notices: [...report.notices],
        callback: report.callback,
    };
    return JSON.stringify(ordered, null, 2);
}
