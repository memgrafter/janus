import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const deployment = readFileSync(join(import.meta.dir, "../../chart/templates/deployment.yaml"), "utf-8");

describe("Helm credential seeding", () => {
	it("does not overwrite OAuth credentials rotated into the PVC", () => {
		expect(deployment).toContain("if [ ! -f {{ .Values.persistence.mountPath }}/auth.json ]; then cp /auth/auth.json");
		expect(deployment).toContain("chmod 600 {{ .Values.persistence.mountPath }}/auth.json");
	});

	it("does not overwrite Cline credentials rotated into the PVC", () => {
		expect(deployment).toContain("if [ ! -f {{ .Values.persistence.mountPath }}/providers.json ]; then cp /cline/providers.json");
		expect(deployment).toContain("chmod 600 {{ .Values.persistence.mountPath }}/providers.json");
	});
});
