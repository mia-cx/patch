"""CPU-only declaration audit against a locally pinned AutoTokenizer; never loads model weights."""

import hashlib
import json
import re
import sys
from pathlib import Path

import transformers
from transformers import AutoTokenizer


def fields(schema):
    """Find field names in parser alternatives as well as declared object/array properties."""
    names = set()
    if not isinstance(schema, dict):
        return names
    for name, child in schema.get("properties", {}).items():
        names.add(name)
        names.update(fields(child))
    for child in schema.get("anyOf", []):
        names.update(fields(child))
    names.update(fields(schema.get("items")))
    return names


def audit(payload):
    tokenizer_dir = Path(sys.argv[1]).resolve()
    tokenizer = AutoTokenizer.from_pretrained(tokenizer_dir, local_files_only=True)
    results = []
    for tool in payload["model_schemas"]:
        name = tool["function"]["name"]
        rendered = tokenizer.apply_chat_template(
            [{"role": "user", "content": "Synthetic declaration check."}],
            tools=[tool],
            tokenize=False,
            add_generation_prompt=True,
        )
        declaration = rendered.split("<|tool>", 1)[1].split("<tool|>", 1)[0]
        expected_fields = fields(payload["parser_schemas"][name])
        missing = sorted(field for field in expected_fields if f"{field}:{{" not in declaration)
        empty_types = bool(re.search(r"type:<\|\"\|>\s*<\|\"\|>", declaration))
        complete_object = declaration.endswith('type:<|"|>OBJECT<|"|>}}')
        if missing or empty_types or not complete_object:
            raise AssertionError({
                "name": name,
                "missing": missing,
                "empty_types": empty_types,
                "complete_object": complete_object,
            })
        if name == "schedule_followup":
            assert "once OR {cron,timezone,text}" in declaration
            assert 'required:[<|"|>text<|"|>]' in declaration
        if name == "memory_forget":
            assert 'id:{nullable:true,type:<|"|>INTEGER<|"|>}' in declaration
        results.append({
            "name": name,
            "visible_fields": sorted(expected_fields),
            "empty_property_types": False,
            "complete_object_declaration": True,
            "rendered_declaration": declaration,
        })
    template = tokenizer_dir / "chat_template.jinja"
    return {
        "status": "passed",
        "tokenizer_path": str(tokenizer_dir),
        "tokenizer_class": type(tokenizer).__name__,
        "transformers": transformers.__version__,
        "template_sha256": hashlib.sha256(template.read_bytes()).hexdigest(),
        "tools_checked": len(results),
        "declarations": results,
        "inference_performed": False,
        "local_files_only": True,
    }


print(json.dumps(audit(json.load(sys.stdin)), ensure_ascii=False))
