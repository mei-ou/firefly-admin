import { describe, expect, it } from "vitest";
import {
	getToolbarCommands,
	TOOLBAR_COMMANDS,
	TOOLBAR_GROUP_LABELS,
} from "../../src/components/articles/toolbar-registry";

describe("编辑器工具栏注册表", () => {
	it("命令 ID 唯一且按三个职责组组织", () => {
		const ids = TOOLBAR_COMMANDS.map((command) => command.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(Object.keys(TOOLBAR_GROUP_LABELS)).toEqual(["inline", "block", "insert"]);
		for (const group of ["inline", "block", "insert"] as const) {
			expect(getToolbarCommands(group).length).toBeGreaterThan(0);
			expect(getToolbarCommands(group).every((command) => command.group === group)).toBe(true);
		}
	});

	it("链接和图片始终位于插入组", () => {
		expect(getToolbarCommands("insert").map((command) => command.id)).toEqual([
			"link",
			"image",
			"divider",
		]);
	});

	it("不注册被 Firefly 语法证据阻断的样式命令", () => {
		const ids = TOOLBAR_COMMANDS.map((command) => command.id);
		expect(ids).not.toContain("underline");
		expect(ids).not.toContain("highlight");
	});

	it("标题只保留左侧下拉入口，不在右侧重复注册", () => {
		const ids = TOOLBAR_COMMANDS.map((command) => command.id);
		expect(ids).not.toContain("heading-1");
		expect(ids).not.toContain("heading-2");
		expect(ids).not.toContain("heading-3");
		expect(ids).not.toContain("heading-4");
		expect(ids).not.toContain("heading-5");
		expect(ids).not.toContain("heading-6");
	});
});
