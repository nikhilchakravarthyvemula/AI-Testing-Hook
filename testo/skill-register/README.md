# Skill Register

Wraps higher-level "skills" the same way `agentic-harness` wraps tools.

A **skill** is a self-contained capability the project exposes for
end-user-driven work: things like `api-test-generator`, future
`ui-test-generator`, `coverage-scorer`, etc. Each skill is a class
with an `execute(args)` method and a pydantic args model. The
SkillService runs them uniformly and normalises results.

## Layout

```
testo/skill-register/
├── skill_register/
│   ├── enums.py / models.py / exceptions.py / interfaces.py
│   ├── registry/skill_registry.py     ← REGISTERED_SKILLS catalog
│   └── services/skill_service.py      ← SkillService.invoke_direct
└── bin/call_skill.py                  ← internal CLI
```

## Adding a skill

1. Write the skill anywhere in the repo (commonly under a layer folder
   like `generation-layer/<name>/skill.py`). It must expose:

   ```python
   from pydantic import BaseModel

   class MySkillArgs(BaseModel):
       foo: str
       count: int = 10

   class MySkill:
       name: str = "my-skill"

       async def execute(self, args: MySkillArgs):
           # do the work
           return MySkillResult(ok=True, ...)
   ```

2. Add a row to `skill_register/registry/skill_registry.py:REGISTERED_SKILLS`:

   ```python
   "my-skill": SkillDefinition(
       name="my-skill",
       source_path=Path("generation-layer/my-skill/skill.py"),
       skill_class="MySkill",
       args_class="MySkillArgs",
       summary="One-line description.",
       layer="generation",
   ),
   ```

3. Done. The CLI auto-discovers it.

## Invoke from the CLI

```bash
./context-layer/content-extractor/graphify/.venv/bin/python testo/skill-register/bin/call_skill.py my-skill --mode direct --foo bar --count 5
```

End users typically don't touch this CLI — they go through `testo`:

```bash
testo generate api-tests   # → calls api-test-generator skill
```

## Relationship to agentic-harness

| | `agentic-harness` | `skill-register` |
|---|---|---|
| **Unit** | a tool (callable function) | a skill (orchestrating capability) |
| **Caller** | LLM (typically) | a `testo` subcommand or another skill |
| **Granularity** | small, fast (bash, read_file) | larger, may chain LLM calls + tool calls |
| **Implementation** | OpenHarness BaseTool | plain Python class |

A skill may invoke many tools through agentic-harness. The two layers
compose cleanly.
