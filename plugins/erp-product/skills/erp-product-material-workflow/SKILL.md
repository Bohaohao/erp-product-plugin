---
name: erp-product-material-workflow
description: "ERP 商品资料维护助手：与用户沟通、读取用户提供的材料并引导补齐业务事实，维护、填写、清空、检查、预检本地 ERP 商品资料包/商品资料.md，并把某目录里的资料整理成可创建的商品资料包。适用于用户说 帮我把某目录里的资料整理成可创建的商品资料包、帮我整理资料然后创建商品、根据商品材料包创建商品 等自然中文请求时。Use when the user wants to organize a local material directory into a create-ready product package before ERP Product MCP precheck and create."
---

# ERP Product Material Workflow

## Purpose

Use this skill as a guided product-material assistant, not merely a validator.

The user may not know how to correctly fill `商品资料.md`. The primary goal is to help the user turn rough product material into a clean, structured `商品资料.md` by:

1. reading the current `商品资料.md` and lightweight file metadata for the package;
2. extracting usable facts from filenames, folder names, small selected documents, existing drafts, and user messages;
3. explaining what is missing in business language;
4. asking only the questions that cannot be inferred safely;
5. filling or updating `商品资料.md` when the user asks to do so;
6. checking required fields and local file references;
7. preparing the package for Product MCP precheck and, only on explicit request, product creation.

Use the published ERP Product MCP tools for runtime/auth/backend work. Do not read tokens, call internal Product MCP modules, or bypass `product_*` tools.

If Product MCP tools are missing or not callable, stop before Product MCP precheck, upload, duplicate check, lookup, or create. Do not fall back to Browser, Chrome DevTools, captured frontend sessions, network-panel requests, or manually reconstructed ERP HTTP calls to mutate ERP data.

## Operating Mode

Default to a conversational fill-and-check loop:

1. Understand the user's goal.
   - "帮我把某目录里的资料整理成可创建的商品资料包": treat this as guided filling plus local validation. Build a metadata-only inventory of the package, create/update `商品资料.md`, ask for missing business facts, verify file paths, and prepare for Product MCP precheck. Do not create the product unless the user later explicitly asks to create.
   - "帮我整理/维护/填写商品资料": inspect `商品资料.md` and lightweight file metadata, infer safe values, and ask for missing facts.
   - "我不知道怎么填": explain each missing field plainly and ask in small groups.
   - "根据这些资料填写": read the provided package/files and draft values into `商品资料.md`.
   - "清空/生成标准模板": keep structure, blank values, remove examples.
   - "检查路径": verify local relative file references.
   - "预检": run local check, then Product MCP precheck when useful.
   - "创建商品": run the full Product MCP create handoff with explicit confirmation.

2. Locate the material package.
   - If the user gives a directory, expect `商品资料.md` inside it; when it is missing, create it from the packaged template.
   - `商品资料.md` must follow the packaged standard template (`assets/商品资料空白模板.md`, schema `assets/商品资料模板.schema.json`). If it is missing or nonstandard, normalize from the packaged template first (see *Standard Template*), preserving any existing values.
   - Treat paths as relative to the directory containing `商品资料.md`.

3. Build a fact inventory before asking questions.
   - Read `商品资料.md` if present.
   - Inspect nearby filenames, folder names, extensions, file sizes, and relative paths before reading file contents.
   - Use user-provided documents, spreadsheets, image names, attachment names, and notes as clues, but read large or binary files only when there is a specific extraction reason.
   - Mark inferred values as "待确认" when they affect business truth.

4. Ask concise grouped questions.
   - Do not ask the user to understand Product MCP IDs or internal schema names.
   - Ask for names, choices, and business decisions.
   - Prefer one compact table of missing/uncertain values over a long questionnaire.

5. Fill/update the document when requested.
   - Preserve the template structure.
   - Prefer names over IDs in `商品资料.md`; resolve IDs later with read-only Product MCP tools.
   - Keep optional fields blank when the user does not know them.
   - Do not ask users to manually provide internal ERP IDs for category config, technical params, optional configs, media, cases, price tiers, or part rows. ID fields needed for creation are system-resolved and carried only inside `draftCreateInput`.
   - Large numeric IDs, if supplied by an exported source or a tool lookup, must remain strings.

## Standard Template

`商品资料.md` must use the packaged standard template distributed inside the skill/plugin body:

- Blank template: `assets/商品资料空白模板.md`.
- Field schema: `assets/商品资料模板.schema.json`.

Rules:

- Treat these asset paths as relative to the skill directory, not to the user's machine. Never hard-code user-specific paths.
- Invoke scripts from the skill directory and let each script locate assets relative to itself. This works the same way in a plugin cache install and in a standalone skill install.
- When creating a new `商品资料.md`, copy the packaged blank template into the package directory; do not hand-write the structure.
- When an existing `商品资料.md` diverges from the standard structure, normalize it to the template structure, preserving every existing value, before any other work.
- Validate template structure with the local check (see *File Path Rules*). Use `--normalize-template` to create a missing document or apply structural normalization in one step.

## Cross-Platform Compatibility

The skill must run identically on Windows, macOS, and Linux:

- Do not rely on hard-coded user paths, drive letters, or home directories.
- Invoke every script by its path inside the skill directory and pass package paths as arguments; let the script resolve assets relative to itself.
- Both plugin-cache installs and standalone skill installs work through this relative lookup, so the same command works regardless of where the skill is deployed.

## Large Package Intake

Treat "整理所有文件资料" as full package management, not full content ingestion.

- For multi-GB packages, cover all files by metadata: relative path, filename, extension, size, directory, and likely use.
- Do not recursively read every file's contents. Never load large images, videos, archives, 3D files, PDFs, Word documents, or spreadsheets into context by default.
- Classify resources from path, filename, extension, and directory first; write relative paths into `商品资料.md`.
- Read only `商品资料.md`, small text-like notes, and selected documents that are likely to contain missing business facts.
- When a large document may contain required facts, ask for confirmation or read a bounded extract instead of full content.
- User-facing reports should say when large files were only inventoried/classified and not content-read.

## Upload Scope Discipline

Metadata-only intake during organization must never silently reduce the upload scope during creation.

- During material organization, the AI may inventory and classify large packages by metadata and read only selected contents (see *Large Package Intake*).
- Once a file is referenced in `商品资料.md` and Product MCP precheck accepts it as a valid `uploadQueue` item, creation must upload every such item. The full set of referenced, precheck-valid files is the creation package; do not split it on your own.
- The AI must not decide on its own to create with only core/representative/main materials and leave remaining referenced rich media (images, videos, attachments, certifications, cases) for later. "Read selectively" applies to organization, never to the upload step.
- Exception — only when the user explicitly asks to create first with main/core/basic materials and finish the remaining media later. Under that exception:
  1. First confirm the reduced scope with the user, listing exactly which referenced files will be excluded from this creation.
  2. Update, or ask the user to update, `商品资料.md` so the excluded files are no longer in the creation package (remove their references from the fields being created now).
  3. Rerun the local check and Product MCP precheck on the reduced `商品资料.md`.
  4. Upload every item in the new `uploadQueue`; nothing in the new queue may be skipped.
- If any referenced valid `uploadQueue` item fails to upload, stop and report the failing file and remediation options: retry, fix the path/permission/file format, replace the file, or explicitly narrow scope through the exception above and recheck. Do not continue to `product_create` with a partial upload set.

## Protect Business Truth

Never invent category, unit, supplier, HS code, price, certification, region scope, or file paths.

Allowed inference:

- Product names from document titles or clearly labeled material.
- Image/video/attachment relative paths when files exist locally.
- Obvious language labels or file categories from folder names.
- Draft descriptions from user-provided prose, as long as uncertainty is called out.

Not allowed without confirmation:

- Picking between ambiguous categories, units, suppliers, regions, dictionaries, or certifications.
- Assuming "global" sales scope when the user has not said so.
- Treating marketing claims, certifications, or compliance attributes as true without source material.

## Required Fields

For a create-ready package, hard-blocking fields are the union of DTO `CommoditySaveDTO` non-optional fields and the frontend save-before-submit blockers:

- `商品中文名称`
- `产品类型`: `整机`, `配件`, or `服务`
- `上架状态`: `上架`, `下架`, or `作废`
- `一级分类`
- `计量单位`
- `供应商`
- `适用范围`: `全球` or `指定区域`; when `指定区域`, collect at least one `适用区域` row.
- `商品主图`: relative path required before create.
- `是否支持拼柜`: `是` or `否`
- `是否可做展品`: `是` or `否`
- `是否需要安装`: `是` or `否`
- `是否有售后门槛`: `是` or `否`
- `是否支持样品`: `是` or `否`
- `是否支持配件单买`: `是` or `否`
- `是否支持 OEM`: `是` or `否`
- `是否支持 ODM`: `是` or `否`
- `是否支持小批量试单`: `是` or `否`
- `是否现货备货`: `是` or `否`
- `是否海外仓备货`: `是` or `否`

Conditional hard blockers:

- If `产品类型=整机`: `产品等级`, `参考成本价 人民币`, `利润率 %`, and at least one `基础配置` row are required. Any filled `基础配置` / `技术参数` row must include its value.
- If `产品类型=整机` or `产品类型=配件`: `包装长 mm`, `包装宽 mm`, `包装高 mm`, `包装费`, `包装重量 kg`, `净重 kg` are required.
- If independent SKU package data exists, every SKU row must include length, width, height, gross weight, net weight, and package fee; package volume is calculated and should not be requested as a hand-filled blocker.

Not hard-blocking (fill when known, do not block creation): `商品英文名称` (optional), `Banner 图` (optional), and `包装方数` (optional/calculated).

Product model rule: `产品型号` is optional, but once filled it must contain only English letters, digits, and spaces, with no leading/trailing spaces, Chinese, punctuation, or special symbols. Treat `spuModel` as a compatibility alias for `产品型号` / `productModel`.

When fields are missing, first check whether the value is already present elsewhere in the package. Then summarize missing and uncertain values in a compact table:

| 字段 | 当前情况 | 建议/需要用户确认 |
|---|---|---|

### Copyable Missing-Field Reply Block

When blocking missing/uncertain fields require user input, immediately after the compact table include a copyable reply block: one field per line in the exact style `字段名：_______` when no candidate exists. This lets the user fill values in place and paste the block back so the next turn can parse it.

Rules:

- Include only the fields that are currently blocking or uncertain, not every possible field by default.
- Use field names that match `商品资料.md` exactly. Include only current blockers, which may include 商品中文名称, 产品类型, 上架状态, 一级分类, 计量单位, 供应商, 适用范围, 适用区域, 商品主图, 产品等级, 参考成本价 人民币, 利润率 %, 包装长 mm, 包装宽 mm, 包装高 mm, 包装费, 包装重量 kg, 净重 kg, and the required support flags. Do not include optional fields such as 商品英文名称, Banner 图, or 包装方数 unless the user explicitly asks.
- If a safe/inferred candidate is useful, replace the blank with that value (for example `一级分类：工程机械 > 挖掘机`), but never put `待确认` inside the value itself.
- Put enum hints after the blank/value, e.g. `产品类型：_______（整机/配件/服务）`, `上架状态：_______（上架/下架/作废）`, `是否支持样品：_______（是/否）`.
- If the user chooses to fill `适用范围=指定区域`, include `适用区域：_______` so the next turn can parse regions.
- On the next turn, parse the user's filled `字段名：值` lines, update `商品资料.md`, and rerun the local check.

Minimal example:

```text
产品类型：_______（整机/配件/服务）
是否支持样品：_______（是/否）
是否支持 OEM：_______（是/否）
```

Ask in this order:

1. Basic identity: Chinese name, product type. (English name is optional.)
2. Business references: category path, unit, and supplier.
3. Sales scope: global or specified regions.
4. Sales/delivery/after-sales support flags: 是否支持拼柜, 是否可做展品, 是否需要安装, 是否有售后门槛, 是否支持样品, 是否支持配件单买, 是否支持 OEM, 是否支持 ODM, 是否支持小批量试单, 是否现货备货, 是否海外仓备货.
5. Media and conditionals: main image relative path, packaging fields for 整机/配件, and 产品等级/参考成本价/利润率 fields for 整机 when they apply.
6. Optional extras when the user has them: 商品英文名称, Banner 图, 包装方数, additional rich media.

## File Path Rules

Before Product MCP precheck, run:

```bash
python "<skill-dir>/scripts/check_material_package.py" "<package-dir-or-md>"
```

Use `--json` when a machine-readable result is needed. Add `--normalize-template` to validate template structure against `assets/商品资料模板.schema.json` and apply structural normalization in one step (existing values are preserved).

Interpret results this way:

- `blocking=true`: stop and report missing required fields, invalid paths, or a nonstandard template structure.
- `template_issues`: structure differs from the packaged standard template; run `--normalize-template` before proceeding.
- `missing_required`: fields the user must fill or confirm.
- `path_issues`: absolute paths, URLs, base64-like values, missing files, or multi-file cells.
- `path_warnings`: suspicious but not strictly blocking items.

Do not upload or create until path issues are resolved. Users should place files under folders such as `图片/`, `视频/`, `附件/`, `认证/`, or `案例/`, then reference them with relative paths like `./图片/主图.jpg`.

## Fast Local Loop

Use this sequence while helping the user fill a package:

1. Read current `商品资料.md` and build a lightweight file-metadata inventory; do not full-read the resource package.
2. If `商品资料.md` is missing or its structure is nonstandard, create or normalize it from the packaged template first (`--normalize-template`), preserving recognizable existing values. Do this before asking questions.
3. Extract safe draft values and identify uncertain fields.
4. If the user asked to fill, edit `商品资料.md`.
5. Run the local script above for immediate field/path and template-structure feedback.
6. Report no more than three groups:
   - already filled or inferred values;
   - missing/uncertain business values;
   - file path issues.
7. Give the next small action: "请确认这 3 个字段" or "把主图放到 ./图片/ 后我继续检查".

## Product MCP Precheck

For a filled package:

1. Run the local script first, including template-structure validation.
2. If local blockers remain, stop and guide the user to fix them.
3. If the template structure is nonstandard, run `--normalize-template` before any MCP call. Never call `product_precheck_package` or `product_create` while template validation fails.
4. If only local cleanup is requested, stop after the local report.
5. For MCP validation, call `product_runtime_self_check` once if the thread has not already verified runtime.
6. If `product_precheck_package` is not callable, stop and report Product MCP tool unavailability; do not use browser/front-end fallbacks.
7. Call `product_precheck_package` with `includeDraft: true`.
8. Report:
   - required-field errors;
   - warnings;
   - generated image crops;
   - upload queue count and representative mappings;
   - unresolved references: category, unit, supplier, regions, dictionaries.
9. If required validation passes and `draft.productNameCn` exists, call `product_check_name_duplicate` before any upload or create.

Only call `product_auth_status` before backend lookups, duplicate checks, uploads, or creation. Pure local template cleanup and local script checks do not need Chrome auth.

## Reference Lookup

Resolve names with read-only tools:

- `product_list_categories` for category paths.
- `product_get_category_config` for units, base configs, technical params, optional configs.
- `product_list_suppliers` for supplier names/IDs.
- `product_list_regions` for applicable regions.
- `product_get_dict` for dictionary labels/values.

Report ambiguous matches and ask the user to choose. Do not silently pick a risky match.

Lookup order for create-ready drafts:

1. Resolve the category path by exact name match with `product_list_categories`. If a selected category has enabled children, continue matching until the exact leaf category is found.
2. Call `product_get_category_config` with the resolved leaf category ID.
3. Use the category config result to fill `unitId`, `baseConfigs[].categoryBaseId`, `technicalParams[].categoryBaseId`, `optionalConfigs[].categoryOptionalId`, and `optionalConfigs[].categoryOptionalConfigId` in the internal create draft. Do not ask the user to fill those IDs in `商品资料.md`.
4. Resolve supplier and region names with their read-only tools.
5. For create operations, do not submit edit-only nested primary keys such as `medias[].id`, `customerCases[].id`, `partLists[].id`, or `priceTiers[].id`.

## Create Handoff

Do not create products as part of ordinary material maintenance. When the user asks to create:

1. Ensure template validation passed; run `--normalize-template` first if the structure is nonstandard.
2. Ensure runtime/auth are ready.
3. Ensure `product_precheck_package` required validation passed.
4. Ensure `product_check_name_duplicate` did not block.
5. If `product_upload_file`, `product_create`, or required lookup tools are not callable, stop and report Product MCP tool unavailability; do not use browser/front-end fallbacks.
6. Upload files with `product_upload_file`, preserving `dedupeKey`, `sourceRelativePath`, and `sourceLocalPath`. Upload every item in the precheck `uploadQueue`; never self-narrow the set to core/main materials (see *Upload Scope Discipline*). If any valid queue item fails to upload, stop and report it; do not proceed to `product_create`.
7. Summarize product name, category, unit, supplier, region scope, main image status, warnings, and upload counts.
8. Call `product_create` only after explicit user confirmation and with `confirm: true`.
9. Verify with `product_get_detail`.

## Deeper Guide

For a fuller operating procedure and response templates, read `references/maintenance-flow.md`.
