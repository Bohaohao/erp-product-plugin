# ERP Product Material Maintenance Flow

## 1. User Intake

Start by identifying the package root and the intended outcome. Assume the user may not know the correct structure of `商品资料.md`; guide them rather than expecting them to provide perfect values.

Common intents:

- "帮我把某目录里的资料整理成可创建的商品资料包": build a metadata-only inventory of the directory, create/update `商品资料.md`, guide the user to confirm missing business facts, run local validation, and prepare the package for Product MCP precheck. This does not mean creating the product yet.
- "帮我整理/维护商品资料": inspect `商品资料.md` and lightweight file metadata, infer safe values, ask for missing facts, and update the document if requested.
- "我不知道怎么填": explain required fields in plain language and ask small grouped questions.
- "根据这些资料填写": read the supplied files/materials and draft values into `商品资料.md`.
- "清空/生成标准模板": keep field structure, blank values, remove examples.
- "检查路径": run local path audit only.
- "预检": local audit, then Product MCP `product_precheck_package`.
- "创建商品": full Product MCP create workflow with explicit confirmation.

If the user gives only a folder, assume the document is `<folder>/商品资料.md`.

## 2. Standard Template Gate

`商品资料.md` must use the packaged template shipped with the skill/plugin:

- Template: `assets/商品资料空白模板.md`
- Schema: `assets/商品资料模板.schema.json`

The local checker locates both assets relative to `scripts/check_material_package.py`, so the same command works from Windows plugin cache paths, macOS/Linux plugin cache paths, and standalone skill installs. Do not hard-code user-specific paths.

Before filling, precheck, upload, or create:

1. Run `scripts/check_material_package.py <package-dir-or-md> --json`.
2. If `template_ok=false`, run `scripts/check_material_package.py <package-dir-or-md> --normalize-template --json`.
3. Continue only after template validation passes. Normalization backs up existing `商品资料.md` and preserves recognizable values in the standard structure.

Product MCP tool availability is also a hard gate. If `product_precheck_package`, lookup, upload, duplicate-check, or create tools are not callable, stop and report the missing Product MCP tool names. Do not continue through Browser tools, Chrome DevTools, frontend session replay, network-panel requests, or manually reconstructed ERP HTTP calls.

The packaged template is intentionally aligned with the ERP create/edit tabs:
基础信息, 产品配置, 价格信息, 库存与物流, 配件备件, 图文信息, 认证资料, and 销售支持.
Use it as a full-detail maintenance document. A package can be locally
create-ready while still producing an empty-looking detail page if rich modules
are omitted, so when the user provides enough materials, fill the non-required
detail sections as well: media galleries, 图文详情卡片, 认证资料, 核心优势,
应用场景, FAQ, 竞品对比, 客户案例, 合规红线, 售后承诺, 故障处理与质保, and
技术支持联系方式.

## 3. Large Package Intake

Treat a request to organize all files as a request to manage and classify the whole package, not to read every file's content.

Default behavior for large packages:

1. Inventory all files by metadata only: relative path, filename, extension, file size, parent folder, and likely use.
2. Classify assets from paths and names first: main image candidates, detail images, videos, manuals, certifications, attachments, case materials, and unknown files.
3. Read `商品资料.md` and small text-like notes first.
4. Read PDF/Word/Excel/image/OCR/video/archive content only when a specific missing fact requires it, and prefer bounded extraction or user confirmation.
5. Write file references as relative paths in the standard template; do not paste file contents or long file lists into the response.

When reporting progress, mention that large files were inventoried/classified rather than content-read.

## 4. Guided Filling Principles

The main job is communication plus assisted filling:

1. Read the current document and lightweight package inventory before asking questions.
2. Extract candidate values from the package:
   - current `商品资料.md`;
   - filenames and folder names;
   - file extensions, sizes, and likely use;
   - selected small notes or bounded extracts from documents when needed;
   - user messages in the current conversation.
3. Separate values into:
   - confirmed values;
   - safe inferred values;
   - uncertain values needing confirmation;
   - missing values.
4. Ask only for business facts that cannot be inferred safely.
5. When the user answers, update `商品资料.md` and rerun the local check.

Do not ask the user for internal IDs unless they come from an exported source or a previous tool lookup. Ask for names and choices, then resolve IDs later through Product MCP read-only lookup tools. IDs for category configs, technical params, optional configs, units, media rows, customer cases, price tiers, and part rows are not user-maintained fields in `商品资料.md`.

## 5. Required Field Filling

Use the create-ready contract formed by DTO `CommoditySaveDTO` non-optional fields plus frontend save-before-submit blockers:

| Field | How user should think about it | How Codex should handle it |
|---|---|---|
| 商品中文名称 | 商品在 ERP 中展示的中文名称 | Must be present before duplicate check |
| 产品类型 | 整机 / 配件 / 服务 | Map to Product MCP productType later |
| 上架状态 | 上架 / 下架 / 作废 | Required by precheck; use 作废 only on explicit request |
| 一级分类 | 商品所属 ERP 分类 | Required; if the selected category has usable children, collect the deeper category path too |
| 计量单位 | 台、件、套等销售/库存单位 | Resolve from `product_get_category_config` |
| 供应商 | 商品对应供应商名称 | Resolve with `product_list_suppliers` |
| 适用范围 | 全球 / 指定区域 | Required; 指定区域 must include at least one region row |
| 商品主图 | 商品首图相对路径 | Required before create |
| 是否支持拼柜 | 是否支持拼柜发货 | 是 / 否；DTO 非可选字段 |
| 是否可做展品 | 是否可作为展品 | 是 / 否；DTO 非可选字段 |
| 是否需要安装 | 是否需要现场安装 | 是 / 否；DTO 非可选字段 |
| 是否有售后门槛 | 是否设置售后门槛 | 是 / 否；DTO 非可选字段 |
| 是否支持样品 | 是否提供样品 | 是 / 否；DTO 非可选字段 |
| 是否支持配件单买 | 配件是否可单独购买 | 是 / 否；DTO 非可选字段 |
| 是否支持 OEM | 是否支持 OEM | 是 / 否；DTO 非可选字段 |
| 是否支持 ODM | 是否支持 ODM | 是 / 否；DTO 非可选字段 |
| 是否支持小批量试单 | 是否接受小批量试单 | 是 / 否；DTO 非可选字段 |
| 是否现货备货 | 是否现货备货 | 是 / 否；DTO 非可选字段 |
| 是否海外仓备货 | 是否海外仓备货 | 是 / 否；DTO 非可选字段 |

Conditional hard blockers:

- If `产品类型=整机`: `产品等级`, `参考成本价 人民币`, `利润率 %`, and at least one `基础配置` row are required; any selected `基础配置` / `技术参数` row must have a value.
- If `产品类型=整机` or `产品类型=配件`: `包装长 mm`, `包装宽 mm`, `包装高 mm`, `包装费`, `包装重量 kg`, `净重 kg` are required.
- If `independentPkg=1` or SKU rows are provided, each SKU must include length, width, height, gross weight, net weight, and package fee. Do not require hand-filled package volume.

Format hard blocker:

- `产品型号` is optional, but if filled it may contain only English letters, digits, and spaces, with no leading/trailing spaces, Chinese, punctuation, or special symbols. Treat `spuModel` as a compatibility alias for `产品型号` / `productModel`.

Not hard-blocking (fill when known, do not block creation):

- `商品英文名称`: optional; fill when English display is needed.
- `Banner 图`: optional.
- `包装方数`: optional/calculated.

Ask for missing values in groups:

1. Basic identity: Chinese name, product type. (English name is optional.)
2. Business references: category path, unit, supplier.
3. Sales scope: global or specified regions.
4. Sales/delivery/after-sales support flags: 是否支持拼柜, 是否可做展品, 是否需要安装, 是否有售后门槛, 是否支持样品, 是否支持配件单买, 是否支持 OEM, 是否支持 ODM, 是否支持小批量试单, 是否现货备货, 是否海外仓备货.
5. Media and conditional blockers: main image path; packaging fields for 整机/配件; 产品等级、参考成本价 人民币、利润率 % and base configuration for 整机.
6. Optional extras when the user has them: 商品英文名称, Banner 图, 包装方数, additional rich media.

Example question style:

```text
我已经从资料里识别到商品中文名和主图，但还有 3 个关键项需要你确认：

| 字段 | 当前情况 | 请确认 |
|---|---|---|
| 计量单位 | 未找到 | 商品计量单位是什么？ |
| 供应商 | 未找到 | 使用哪个供应商？ |
```

When these blocking fields require user input, immediately after the compact table add a copyable reply block: one field per line in the exact style `字段名：_______` when no candidate exists. Include only the fields that are currently blocking or uncertain (not every field by default), use field names that match `商品资料.md`, and replace blanks with safe/inferred candidates when useful without ever writing `待确认` inside the value. Put enum hints after the blank/value; if `产品类型` makes packaging or whole-machine fields mandatory, include those exact template field names. If the user chooses `适用范围=指定区域`, include `适用区域：_______`. On the next turn, parse the user's filled `字段名：值` lines, update `商品资料.md`, and rerun the local check.

```text
产品类型：_______（整机/配件/服务）
上架状态：上架（上架/下架/作废）
供应商：_______
是否支持拼柜：_______（是/否）
是否可做展品：_______（是/否）
是否需要安装：_______（是/否）
是否有售后门槛：_______（是/否）
是否支持样品：_______（是/否）
是否支持配件单买：_______（是/否）
是否支持 OEM：_______（是/否）
是否支持 ODM：_______（是/否）
是否支持小批量试单：_______（是/否）
是否现货备货：_______（是/否）
是否海外仓备货：_______（是/否）
```

## 6. File Reference Confirmation

Before Product MCP precheck:

1. Read the Markdown.
2. Run `scripts/check_material_package.py`.
3. If template structure is nonstandard, run `--normalize-template` before any Product MCP call.
4. Fix these blockers first:
   - URL or OSS URL in a file column.
   - Absolute local path such as `D:\...`.
   - Missing relative file.
   - Multiple paths in one cell.
   - Base64-like content.
5. Keep one file per row for repeatable upload mapping.

Path examples:

```text
./图片/主图.jpg
./视频/作业视频.mp4
./附件/说明书.pdf
./认证/CE证书.pdf
```

Avoid:

```text
D:\private\商品材料包\图片\主图.jpg
https://example.com/main.jpg
data:image/png;base64,...
./图片/1.jpg; ./图片/2.jpg
```

## 7. Fast Confirmation Loop

Use this loop while the user is filling the document:

1. Build a metadata-only package inventory and read the current document.
2. If `商品资料.md` is missing or nonstandard, create/normalize from the packaged template first.
3. Fill safe values if the user asked Codex to fill.
4. Run local script check.
5. Summarize no more than three groups:
   - Filled/inferred values.
   - Missing or uncertain required values.
   - File path issues.
6. If there are blockers, give precise edits:
   - field name or table row;
   - current value;
   - expected form.
7. When local blockers are gone, offer Product MCP precheck.

## 8. Product MCP Precheck Loop

When the user asks for official precheck:

1. `product_runtime_self_check` if runtime has not been verified in this thread.
2. Do not call Product MCP if `template_ok=false`; normalize first.
3. If `product_precheck_package` is not callable, stop and report Product MCP tool unavailability.
4. `product_precheck_package({ packagePath, includeDraft: true })`.
5. Read `ok`, `issues`, `readiness`, `unresolvedReferences`, and `uploadQueue`.
6. Report:
   - blocking errors first;
   - warnings second;
   - valid upload count and generated crops;
   - unresolved references that need lookup or user choice.
7. Resolve lookup references in order: exact category path with `product_list_categories`, leaf-category config with `product_get_category_config`, supplier names with `product_list_suppliers`, and specified regions with `product_list_regions`. Use category config to fill `unitId`, base config IDs, technical param IDs, optional config IDs, and optional config item IDs inside the internal draft; do not ask the user to type these IDs.
8. If `ok=true` and `draftCreateInput.productNameCn` exists, run duplicate check before upload.

`product_precheck_package` is validation and draft preparation. It does not upload and does not create.

Create payloads must not include edit-only nested primary keys such as `medias[].id`, `customerCases[].id`, `partLists[].id`, or `priceTiers[].id`. If those IDs appear in imported full-form data, strip them before `product_create`.

### Upload scope from `uploadQueue`

`uploadQueue` defines the required upload set for the current `商品资料.md`. It is the authoritative list of files that the current package references and that Product MCP expects to receive.

- Treat every valid `uploadQueue` item as required. A valid item is one whose local relative path resolves and is not flagged as an error in `issues`.
- All valid `uploadQueue` items must be uploaded (and confirmed uploaded) before `product_create`. Do not start creation with a partial upload set.
- Do not silently split the queue into "core materials first" and "rich media later". If a file is in the valid `uploadQueue`, it is part of this build, not a follow-up.
- If a non-required rich media / reference file fails to upload (i.e. a file that is referenced but not part of the valid `uploadQueue`, or one the user added beyond the required set), stop and report options to the user — retry, fix the path/permission/file format, replace the file, or explicitly narrow scope through the user-confirmed update-and-recheck exception — instead of proceeding with a reduced product.

## 9. Response Pattern

For maintenance/precheck reports, use this shape:

```text
当前状态：可继续 / 需要补充 / 阻塞

已整理：
- ...

需要你确认：
| 字段 | 当前情况 | 请确认 |
|---|---|---|

请直接补全并粘贴回来（只列当前阻塞/不确定的字段）：
产品类型：_______（整机/配件/服务）

文件路径：
- 无问题 / 有 N 个问题

下一步：
- ...
```

Keep user-facing reports business-readable. Put raw tool details only when they help the user fix a concrete issue.

## 10. Safety Gates

Never proceed to upload/create when:

- Required fields are missing.
- Template validation fails.
- Required Product MCP tools are not callable.
- Main image path is missing or invalid.
- Duplicate check blocks.
- The user has not explicitly confirmed creation.
- The package contains local absolute paths, URLs, or base64 file content where local relative paths are expected.
- The valid `uploadQueue` is not fully uploaded. Never call `product_create` while any valid `uploadQueue` item is still pending, skipped, or failed.
- Any valid referenced file (a file in the valid `uploadQueue`) was skipped or failed during upload. The product must be built from the complete, validated upload set — not a reduced one.

The only exception to the upload-completeness gates above is when the user has explicitly asked to narrow the material scope (for example: "this build only needs the core materials and the main image, skip the rest"), and `商品资料.md` was updated to match that narrower scope and rechecked with `product_precheck_package` so the new `uploadQueue` reflects only the agreed files. In that case the reduced upload set is the agreed scope, not a silent fallback.

### Prohibited response pattern

Never propose, imply, or proceed with a reduced first build on your own initiative. The pattern below is prohibited unless the user explicitly requests a narrowed scope as described above:

```text
先用核心资料 + 代表性素材完成首建，剩余富媒体后续补。
```

This is not allowed by default. "Core materials + representative media first, complete the remaining rich media later" hides a skipped upload set behind a finished-looking product. If you cannot complete the valid `uploadQueue`, stop and report the options (retry, fix the path/permission/file format, replace the file, or ask the user to explicitly narrow scope through the update-and-recheck exception) rather than advertising a partial build as done.

For normal material maintenance, stop at a clean precheck summary.
