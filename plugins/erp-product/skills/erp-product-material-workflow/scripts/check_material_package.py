#!/usr/bin/env python3
"""Quick local checker for ERP Product MCP 商品资料.md packages.

This script does not call Product MCP. It checks required fields and obvious
file-reference mistakes before the official product_precheck_package step.
"""

from __future__ import annotations

import argparse
import base64
from datetime import datetime
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, Iterable, List, Tuple


SKILL_DIR = Path(__file__).resolve().parents[1]
ASSETS_DIR = SKILL_DIR / "assets"
TEMPLATE_PATH = ASSETS_DIR / "商品资料空白模板.md"
SCHEMA_PATH = ASSETS_DIR / "商品资料模板.schema.json"
TEMPLATE_MARKER_RE = re.compile(r"<!--\s*erp-product-material-template-version:\s*([^>]+?)\s*-->")


REQUIRED_FIELD_ROWS = [
    "商品中文名称",
    "产品类型",
    "上架状态",
    "一级分类",
    "计量单位",
    "供应商",
    "适用范围",
    "是否支持拼柜",
    "是否可做展品",
    "是否需要安装",
    "是否有售后门槛",
    "是否支持样品",
    "是否支持配件单买",
    "是否支持 OEM",
    "是否支持 ODM",
    "是否支持小批量试单",
    "是否现货备货",
    "是否海外仓备货",
]
PRODUCT_MODEL_RE = re.compile(r"^[A-Za-z0-9 ]+$")

PATH_HEADERS_STRICT = {"文件路径", "主图路径", "图片路径", "附件路径"}
PATH_HEADERS_LOOSE = {"文件路径或内容"}
STATIC_TEMPLATE_COLUMNS = {"填写说明", "数量/比例说明", "限制"}
PATH_EXT_RE = re.compile(
    r"\.(jpg|jpeg|png|gif|webp|mp4|glb|pdf|doc|docx|xls|xlsx|ppt|pptx|txt|rar|7z|csv)\b",
    re.IGNORECASE,
)
URL_RE = re.compile(r"^(https?://|oss://)", re.IGNORECASE)
ABS_WIN_RE = re.compile(r"^[a-zA-Z]:[\\/]")
BASE64_RE = re.compile(r"^(data:[^,]+;base64,|[A-Za-z0-9+/]{120,}={0,2}$)")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def load_schema() -> Dict[str, Any]:
    if not SCHEMA_PATH.exists():
        raise SystemExit(f"未找到商品资料模板 schema：{SCHEMA_PATH}")
    return json.loads(read_text(SCHEMA_PATH))


def resolve_markdown_path(raw: str, allow_missing: bool = False) -> Path:
    path = Path(raw).expanduser()
    if path.is_dir():
        path = path / "商品资料.md"
    if not path.exists():
        if allow_missing:
            parent = path.parent
            if not parent.exists():
                raise SystemExit(f"商品资料文档目录不存在：{parent}")
            return path.resolve()
        raise SystemExit(f"未找到商品资料文档：{path}")
    if not path.is_file():
        raise SystemExit(f"路径不是文件：{path}")
    return path.resolve()


def split_row(line: str) -> List[str]:
    stripped = line.strip()
    if not stripped.startswith("|") or not stripped.endswith("|"):
        return []
    return [cell.strip() for cell in stripped.strip("|").split("|")]


def is_separator(cells: List[str]) -> bool:
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", cell.strip()) for cell in cells)


def iter_tables(lines: List[str]) -> Iterable[Tuple[int, List[str], List[List[str]]]]:
    index = 0
    while index < len(lines):
        header = split_row(lines[index])
        if not header or index + 1 >= len(lines):
            index += 1
            continue
        sep = split_row(lines[index + 1])
        if not is_separator(sep):
            index += 1
            continue
        rows: List[List[str]] = []
        row_index = index + 2
        while row_index < len(lines):
            row = split_row(lines[row_index])
            if not row:
                break
            rows.append(row)
            row_index += 1
        yield index + 1, header, rows
        index = row_index + 1


def row_value_map(tables: Iterable[Tuple[int, List[str], List[List[str]]]]) -> Dict[str, str]:
    values: Dict[str, str] = {}
    for _, header, rows in tables:
        if len(header) < 2:
            continue
        if header[0] != "字段" or header[1] != "填写值":
            continue
        for row in rows:
            if len(row) >= 2 and row[0]:
                values[row[0]] = row[1].strip()
    return values


def dict_rows_by_first_header(
    tables: Iterable[Tuple[int, List[str], List[List[str]]]], first_header: str
) -> List[Dict[str, str]]:
    dict_rows: List[Dict[str, str]] = []
    for _, header, rows in tables:
        if not header or header[0] != first_header:
            continue
        for row in rows:
            item: Dict[str, str] = {}
            for index, column in enumerate(header):
                item[column] = row[index].strip() if index < len(row) else ""
            dict_rows.append(item)
    return dict_rows


def has_any_row_value(rows: List[Dict[str, str]], ignored_columns: set[str] | None = None) -> bool:
    ignored = ignored_columns or set()
    for row in rows:
        if any(value for column, value in row.items() if column not in ignored):
            return True
    return False


def keyed_row_map(tables: Iterable[Tuple[int, List[str], List[List[str]]]]) -> Dict[str, Dict[str, str]]:
    values: Dict[str, Dict[str, str]] = {}
    for _, header, rows in tables:
        for row in rows:
            if not row or not row[0].strip():
                continue
            key = row[0].strip()
            entry = values.setdefault(key, {})
            for index, column in enumerate(header):
                if index >= len(row):
                    continue
                value = row[index].strip()
                if value and column not in entry:
                    entry[column] = value
    return values


def extract_template_version(text: str) -> str | None:
    match = TEMPLATE_MARKER_RE.search(text)
    return match.group(1).strip() if match else None


def markdown_headings(lines: List[str]) -> set[str]:
    return {line.strip() for line in lines if line.strip().startswith("#")}


def table_headers(tables: Iterable[Tuple[int, List[str], List[List[str]]]]) -> List[List[str]]:
    return [header for _, header, _ in tables]


def first_column_values(tables: Iterable[Tuple[int, List[str], List[List[str]]]], header_name: str) -> set[str]:
    values: set[str] = set()
    for _, header, rows in tables:
        if not header or header[0] != header_name:
            continue
        for row in rows:
            if row and row[0].strip():
                values.add(row[0].strip())
    return values


def issue(code: str, message: str, **extra: Any) -> dict:
    payload = {"code": code, "message": message}
    payload.update(extra)
    return payload


def check_template_structure(
    text: str,
    lines: List[str],
    tables: List[Tuple[int, List[str], List[List[str]]]],
    schema: Dict[str, Any],
) -> Tuple[bool, str | None, List[dict]]:
    issues: List[dict] = []
    version = extract_template_version(text)
    expected_version = schema.get("templateVersion")
    if not version:
        issues.append(issue("MISSING_TEMPLATE_VERSION", "缺少商品资料标准模板版本标记。"))
    elif expected_version and version != expected_version:
        issues.append(
            issue(
                "TEMPLATE_VERSION_MISMATCH",
                "商品资料模板版本与当前标准不一致。",
                expected=expected_version,
                actual=version,
            )
        )

    present_headings = markdown_headings(lines)
    for heading in schema.get("requiredSections", []):
        if heading not in present_headings:
            issues.append(issue("MISSING_SECTION", "缺少标准模板章节。", section=heading))

    present_headers = table_headers(tables)
    for expected_header in schema.get("requiredTableHeaders", []):
        if expected_header not in present_headers:
            issues.append(issue("MISSING_TABLE_HEADER", "缺少标准模板表头。", header=expected_header))

    field_rows = first_column_values(tables, "字段")
    for field in schema.get("requiredFieldRows", []):
        if field not in field_rows:
            issues.append(issue("MISSING_FIELD_ROW", "缺少标准字段行。", field=field))

    image_rows = first_column_values(tables, "图片用途")
    for image_row in schema.get("requiredImageRows", []):
        if image_row not in image_rows:
            issues.append(issue("MISSING_IMAGE_ROW", "缺少标准图片用途行。", row=image_row))

    return not issues, version, issues


def looks_like_path(value: str) -> bool:
    value = value.strip()
    return (
        value.startswith("./")
        or value.startswith("../")
        or "\\" in value
        or "/" in value
        or bool(PATH_EXT_RE.search(value))
        or bool(URL_RE.search(value))
        or bool(ABS_WIN_RE.search(value))
    )


def split_path_candidates(value: str) -> List[str]:
    cleaned = value.replace("<br>", "\n").replace("<br/>", "\n").replace("<br />", "\n")
    parts = re.split(r"[\n;；]", cleaned)
    return [part.strip() for part in parts if part.strip()]


def merge_template_row(row: List[str], header: List[str], source_rows: Dict[str, Dict[str, str]]) -> List[str]:
    if not row or not row[0].strip():
        return row
    source = source_rows.get(row[0].strip())
    if not source:
        return row
    merged = list(row)
    for index, column in enumerate(header):
        if index == 0 or column in STATIC_TEMPLATE_COLUMNS or index >= len(merged):
            continue
        value = source.get(column)
        if value:
            merged[index] = value
    return merged


def render_row(cells: List[str]) -> str:
    return "| " + " | ".join(cells) + " |"


def normalize_template_text(template_text: str, source_text: str) -> str:
    source_tables = list(iter_tables(source_text.splitlines())) if source_text else []
    source_rows = keyed_row_map(source_tables)

    template_lines = template_text.splitlines()
    output: List[str] = []
    index = 0
    while index < len(template_lines):
        header = split_row(template_lines[index])
        if not header or index + 1 >= len(template_lines):
            output.append(template_lines[index])
            index += 1
            continue
        sep = split_row(template_lines[index + 1])
        if not is_separator(sep):
            output.append(template_lines[index])
            index += 1
            continue

        output.append(render_row(header))
        output.append(render_row(sep))
        row_index = index + 2
        while row_index < len(template_lines):
            row = split_row(template_lines[row_index])
            if not row:
                break
            output.append(render_row(merge_template_row(row, header, source_rows)))
            row_index += 1
        index = row_index

    return "\n".join(output).rstrip() + "\n"


def normalize_template(md_path: Path) -> Tuple[bool, str | None]:
    if not TEMPLATE_PATH.exists():
        raise SystemExit(f"未找到商品资料标准模板：{TEMPLATE_PATH}")

    template_text = read_text(TEMPLATE_PATH)
    source_text = read_text(md_path) if md_path.exists() else ""
    backup_path: str | None = None
    if md_path.exists():
        timestamp = datetime.now().strftime("%Y%m%d%H%M%S")
        backup = md_path.with_name(f"{md_path.name}.bak-{timestamp}")
        backup.write_text(source_text, encoding="utf-8")
        backup_path = str(backup)

    md_path.write_text(normalize_template_text(template_text, source_text), encoding="utf-8")
    return True, backup_path


def check_paths(md_path: Path, lines: List[str]) -> Tuple[List[dict], List[dict], int]:
    issues: List[dict] = []
    warnings: List[dict] = []
    checked = 0
    base_dir = md_path.parent

    for start_line, header, rows in iter_tables(lines):
        path_indexes: List[Tuple[int, str, bool]] = []
        for idx, name in enumerate(header):
            if name in PATH_HEADERS_STRICT:
                path_indexes.append((idx, name, True))
            elif name in PATH_HEADERS_LOOSE:
                path_indexes.append((idx, name, False))
        if not path_indexes:
            continue

        for row_offset, row in enumerate(rows, start=2):
            row_label = row[0] if row else ""
            for idx, header_name, strict in path_indexes:
                if idx >= len(row):
                    continue
                raw = row[idx].strip()
                if not raw:
                    continue
                if not strict and not looks_like_path(raw):
                    continue

                candidates = split_path_candidates(raw)
                if len(candidates) > 1:
                    issues.append(
                        {
                            "line": start_line + row_offset,
                            "row": row_label,
                            "column": header_name,
                            "value": raw,
                            "code": "MULTIPLE_PATHS_IN_CELL",
                            "message": "一个单元格中包含多个文件路径；请改为一行一个文件。",
                        }
                    )

                for candidate in candidates:
                    checked += 1
                    if URL_RE.search(candidate):
                        issues.append(path_issue(start_line + row_offset, row_label, header_name, candidate, "URL_NOT_ALLOWED", "文件字段应填写本地相对路径，不填写 URL 或 OSS URL。"))
                        continue
                    if BASE64_RE.search(candidate):
                        issues.append(path_issue(start_line + row_offset, row_label, header_name, candidate, "BASE64_NOT_ALLOWED", "文件字段不能填写 base64 内容。"))
                        continue
                    if ABS_WIN_RE.search(candidate) or candidate.startswith("/") or candidate.startswith("\\"):
                        issues.append(path_issue(start_line + row_offset, row_label, header_name, candidate, "ABSOLUTE_PATH_NOT_ALLOWED", "文件字段应填写相对路径，不填写本机绝对路径。"))
                        continue
                    if not looks_like_path(candidate):
                        warnings.append(path_issue(start_line + row_offset, row_label, header_name, candidate, "SUSPICIOUS_PATH_VALUE", "该值不像文件路径，请确认是否应留空或改为相对路径。"))
                        continue
                    resolved = (base_dir / candidate).resolve()
                    try:
                        resolved.relative_to(base_dir.resolve())
                    except ValueError:
                        issues.append(path_issue(start_line + row_offset, row_label, header_name, candidate, "PATH_ESCAPES_PACKAGE", "文件路径不应跳出资料包目录。"))
                        continue
                    if not resolved.exists():
                        issues.append(path_issue(start_line + row_offset, row_label, header_name, candidate, "FILE_NOT_FOUND", f"文件不存在：{resolved}"))

    return issues, warnings, checked


def path_issue(line: int, row: str, column: str, value: str, code: str, message: str) -> dict:
    return {
        "line": line,
        "row": row,
        "column": column,
        "value": value,
        "code": code,
        "message": message,
    }


def missing_issue(field: str, message: str) -> dict:
    return issue("CONDITIONAL_REQUIRED_MISSING", message, field=field)


def numeric_value(value: str) -> float | None:
    if not value:
        return None
    try:
        return float(value)
    except ValueError:
        return None


def check_price_tiers(tables: List[Tuple[int, List[str], List[List[str]]]]) -> List[dict]:
    issues: List[dict] = []
    rows = dict_rows_by_first_header(tables, "最小数量")
    fields = ["最小数量", "最大数量", "单价", "利润率 %", "最短交货天数", "最长交货天数"]
    for index, row in enumerate(rows, start=1):
        if not any(row.get(field) for field in fields):
            continue
        parsed = {field: numeric_value(row.get(field, "")) for field in fields}
        for field in fields:
            if parsed[field] is None:
                issues.append(issue("PRICE_TIER_ROW_INCOMPLETE", f"价格阶梯第 {index} 行必须补全 {field}。", field=field, row=index))
        if parsed["最小数量"] is not None and parsed["最大数量"] is not None and parsed["最大数量"] < parsed["最小数量"]:
            issues.append(issue("PRICE_TIER_QUANTITY_RANGE_INVALID", f"价格阶梯第 {index} 行最大数量不能小于最小数量。", field="最大数量", row=index))
        if parsed["最短交货天数"] is not None and parsed["最长交货天数"] is not None and parsed["最长交货天数"] < parsed["最短交货天数"]:
            issues.append(issue("PRICE_TIER_DELIVERY_RANGE_INVALID", f"价格阶梯第 {index} 行最长交货天数不能小于最短交货天数。", field="最长交货天数", row=index))
    return issues


def check_sales_supports(values: Dict[str, str], tables: List[Tuple[int, List[str], List[List[str]]]]) -> List[dict]:
    issues: List[dict] = []
    rows = [row for row in dict_rows_by_first_header(tables, "类型") if "标题/问题/异议" in row and "内容/回答/处理方式" in row]
    for index, row in enumerate(rows, start=1):
        support_type = row.get("类型", "")
        has_content = any(row.get(field) for field in ["标题/问题/异议", "内容/回答/处理方式", "文件路径"])
        if not has_content:
            continue
        if support_type == "一句话卖点":
            if not row.get("内容/回答/处理方式"):
                issues.append(issue("SALES_ONE_LINE_CONTENT_REQUIRED", f"销售支持第 {index} 行（一句话卖点）必须填写内容。", field="内容/回答/处理方式", row=index))
            continue
        if support_type in {"核心优势", "应用场景", "常见问题与标准回答", "常见问题&标准回答", "异议处理", "合规红线", "售后承诺", "售后服务与支持", "质保政策"}:
            if not row.get("标题/问题/异议") or not row.get("内容/回答/处理方式"):
                issues.append(issue("SALES_SUPPORT_ROW_INCOMPLETE", f"销售支持第 {index} 行必须同时填写标题和内容。", field="销售支持", row=index))

    tech_fields = ["技术支持联系人", "联系电话", "电子邮箱", "服务时间", "备用联系方式"]
    if any(values.get(field) for field in tech_fields):
        if not values.get("技术支持联系人"):
            issues.append(issue("SALES_TECH_SUPPORT_CONTACT_REQUIRED", "技术支持联系方式已填写部分内容时，必须填写技术支持联系人。", field="技术支持联系人"))
        if not values.get("服务时间"):
            issues.append(issue("SALES_TECH_SUPPORT_HOURS_REQUIRED", "技术支持联系方式已填写部分内容时，必须填写服务时间。", field="服务时间"))
        if not (values.get("联系电话") or values.get("电子邮箱") or values.get("备用联系方式")):
            issues.append(issue("SALES_TECH_SUPPORT_CHANNEL_REQUIRED", "技术支持联系方式必须至少填写联系电话、电子邮箱或备用联系方式之一。", field="联系电话"))
    return issues


def check_business_rules(values: Dict[str, str], tables: List[Tuple[int, List[str], List[List[str]]]]) -> Tuple[List[str], List[dict]]:
    missing: List[str] = []
    issues: List[dict] = []

    product_model = values.get("产品型号", "")
    if product_model and (not PRODUCT_MODEL_RE.fullmatch(product_model) or product_model != product_model.strip()):
        issues.append(
            issue(
                "PRODUCT_MODEL_FORMAT_INVALID",
                "产品型号仅允许英文大小写、数字和空格，且不能有首尾空格、中文或符号。",
                field="产品型号",
            )
        )

    image_rows = dict_rows_by_first_header(tables, "图片用途")
    main_image = next((row for row in image_rows if row.get("图片用途") == "商品主图"), None)
    if not main_image or not main_image.get("文件路径"):
        missing.append("商品主图")
        issues.append(missing_issue("商品主图", "创建商品前必须填写商品主图相对路径。"))

    if values.get("适用范围") == "指定区域":
        region_rows = dict_rows_by_first_header(tables, "区域名称")
        if not any(row.get("区域名称") or row.get("区域ID") for row in region_rows):
            missing.append("适用区域")
            issues.append(missing_issue("适用区域", "适用范围为指定区域时，必须填写至少一行区域明细。"))

    product_type = values.get("产品类型")
    if product_type == "整机":
        for field in ["产品等级", "参考成本价 人民币", "利润率 %"]:
            if not values.get(field):
                missing.append(field)
                issues.append(missing_issue(field, f"产品类型为整机时，{field}必填。"))

        base_rows = dict_rows_by_first_header(tables, "配置项名称")
        if not has_any_row_value(base_rows, {"备注"}):
            missing.append("基础配置")
            issues.append(missing_issue("基础配置", "产品类型为整机时，必须填写至少一行基础配置。"))
        for index, row in enumerate(base_rows, start=1):
            if row.get("配置项名称") and not row.get("配置值"):
                issues.append(
                    issue(
                        "BASE_CONFIG_VALUE_REQUIRED",
                        f"基础配置第 {index} 行已填写配置项名称，必须补全配置值。",
                        field="配置值",
                        row=index,
                    )
                )

        tech_rows = dict_rows_by_first_header(tables, "参数名称")
        for index, row in enumerate(tech_rows, start=1):
            if row.get("参数名称") and not row.get("参数值"):
                issues.append(
                    issue(
                        "TECHNICAL_PARAM_VALUE_REQUIRED",
                        f"技术参数第 {index} 行已填写参数名称，必须补全参数值。",
                        field="参数值",
                        row=index,
                    )
                )

    if product_type in {"整机", "配件"}:
        for field in ["包装长 mm", "包装宽 mm", "包装高 mm", "包装费", "包装重量 kg", "净重 kg"]:
            if not values.get(field):
                missing.append(field)
                issues.append(missing_issue(field, f"产品类型为{product_type}时，{field}必填。"))

    issues.extend(check_price_tiers(tables))
    issues.extend(check_sales_supports(values, tables))

    return missing, issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Check 商品资料.md required fields and local file references.")
    parser.add_argument("path", help="Package directory or 商品资料.md path")
    parser.add_argument("--json", action="store_true", help="Emit JSON only")
    parser.add_argument("--normalize-template", action="store_true", help="Rewrite 商品资料.md with the packaged standard template while preserving recognized values")
    args = parser.parse_args()

    schema = load_schema()
    md_path = resolve_markdown_path(args.path, allow_missing=args.normalize_template)
    normalized = False
    backup_path: str | None = None
    if args.normalize_template:
        normalized, backup_path = normalize_template(md_path)

    text = read_text(md_path)
    lines = text.splitlines()
    tables = list(iter_tables(lines))
    values = row_value_map(tables)
    template_ok, template_version, template_issues = check_template_structure(text, lines, tables, schema)

    missing = [field for field in REQUIRED_FIELD_ROWS if not values.get(field)]
    conditional_missing, business_issues = check_business_rules(values, tables)
    for field in conditional_missing:
        if field not in missing:
            missing.append(field)

    path_issues, path_warnings, checked_paths = check_paths(md_path, lines)
    result = {
        "ok": template_ok and not missing and not business_issues and not path_issues,
        "blocking": bool(template_issues or missing or business_issues or path_issues),
        "markdownPath": str(md_path),
        "packageDir": str(md_path.parent),
        "template_ok": template_ok,
        "template_version": template_version,
        "template_issues": template_issues,
        "normalized": normalized,
        "backupPath": backup_path,
        "missing_required": missing,
        "business_issues": business_issues,
        "checked_path_count": checked_paths,
        "path_issues": path_issues,
        "path_warnings": path_warnings,
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"商品资料快速检查：{'通过' if result['ok'] else '需要处理'}")
        print(f"文档：{md_path}")
        if normalized:
            print("\n已按标准模板归一化商品资料。")
            if backup_path:
                print(f"原文件备份：{backup_path}")
        if template_issues:
            print("\n模板结构问题：")
            for template_issue in template_issues:
                detail = template_issue.get("section") or template_issue.get("field") or template_issue.get("row") or template_issue.get("header") or ""
                print(f"- {template_issue['message']} {detail}".rstrip())
        if missing:
            print("\n缺少必填项：")
            for field in missing:
                print(f"- {field}")
        if business_issues:
            print("\n业务规则问题：")
            for business_issue in business_issues:
                detail = business_issue.get("field") or ""
                print(f"- {business_issue['message']} {detail}".rstrip())
        if path_issues:
            print("\n文件路径问题：")
            for issue in path_issues:
                print(f"- 第 {issue['line']} 行 [{issue['row']} / {issue['column']}]: {issue['message']} 当前值：{issue['value']}")
        if path_warnings:
            print("\n文件路径提醒：")
            for warning in path_warnings:
                print(f"- 第 {warning['line']} 行 [{warning['row']} / {warning['column']}]: {warning['message']} 当前值：{warning['value']}")
        if not missing and not path_issues:
            print("\n本地必填字段和路径检查未发现阻塞问题。可继续执行 Product MCP 预检。")
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
