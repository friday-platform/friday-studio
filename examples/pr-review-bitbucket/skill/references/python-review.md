# Python-Specific Review Criteria

Apply these criteria **in addition to** the general review criteria when the PR
contains `.py` files. Python's dynamic nature, mutable defaults, and GIL
semantics create unique footguns that generic reviews miss.

## 1. Type Safety & Dynamic Typing Pitfalls

Python's dynamic typing is flexible but error-prone without discipline.

**Look for:**
- **Missing type annotations** — public functions and module-level variables
  should have type hints. Use `mypy` or `pyright` strict mode to catch type
  mismatches before runtime.
- **Mutable default arguments** — `def f(items=[])` shares the list across all
  calls. Use `None` sentinel: `def f(items=None): items = items or []` or
  `def f(items: list[str] | None = None)`.
- **Unsafe `isinstance` checks** — `isinstance(x, dict)` doesn't narrow generic
  types. Use `TypeGuard` or structural checks for complex narrowing.
- **`Any` type usage** — `Any` disables type checking at that boundary. Use
  `object` or `Unknown` (pyright) for truly unknown types and narrow explicitly.
- **String-based type references** — forward references via strings
  (`"MyClass"`) should use `from __future__ import annotations` instead for
  consistency.
- **Incorrect `Optional` usage** — `Optional[X]` means `X | None`, not
  "parameter is optional." Confusing the two leads to subtle bugs.
- **Unvalidated external data** — `json.loads()`, `pickle.loads()`, form data,
  or API responses used without validation. Use Pydantic models or
  `TypeAdapter` to parse untrusted data.

**Severity guidance:**
- Mutable default argument: **warning**
- `Any` in production code path: **warning**
- Unvalidated external data: **critical**
- Missing type hints on public API: **suggestion**

**Anti-patterns:**
```python
# BAD: mutable default shared across calls
def add_item(item, items=[]):
    items.append(item)
    return items

# GOOD: None sentinel
def add_item(item: str, items: list[str] | None = None) -> list[str]:
    if items is None:
        items = []
    items.append(item)
    return items
```

```python
# BAD: unvalidated JSON
data = json.loads(request.body)
user_id = data["user_id"]  # KeyError if missing, no type safety

# GOOD: validated with Pydantic
class Payload(BaseModel):
    user_id: int

payload = Payload.model_validate_json(request.body)
user_id = payload.user_id  # fully typed, validated
```

## 2. Concurrency & Async

Python's GIL and async model create unique concurrency concerns.

**Look for:**
- **Blocking calls in async functions** — `time.sleep()`, synchronous I/O, or
  CPU-bound work inside `async def` blocks the event loop. Use
  `asyncio.sleep()`, `asyncio.to_thread()`, or run in an executor.
- **Missing `await`** — calling a coroutine without `await` returns a coroutine
  object instead of executing it. Usually a silent bug.
- **Shared mutable state across async tasks** — even with the GIL, `await`
  points are preemption points. State can change between any two `await` calls.
- **Thread safety with the GIL** — the GIL protects bytecode operations, not
  application logic. Compound operations (`check-then-act`) are still racy.
  Use `threading.Lock` for critical sections.
- **`asyncio.gather` without `return_exceptions`** — one exception cancels all
  tasks. Use `return_exceptions=True` or `asyncio.TaskGroup` (3.11+) for
  structured concurrency.
- **Daemon threads holding resources** — daemon threads are killed abruptly on
  exit without running `finally` blocks or cleanup.

**Severity guidance:**
- Blocking call in async function: **critical**
- Missing `await` on coroutine: **critical**
- Race condition at await points: **warning**
- Missing `return_exceptions` in gather: **suggestion**

**Anti-patterns:**
```python
# BAD: blocks the event loop
async def fetch_data():
    time.sleep(5)  # blocks!
    response = requests.get(url)  # blocks!

# GOOD: non-blocking
async def fetch_data():
    await asyncio.sleep(5)
    async with httpx.AsyncClient() as client:
        response = await client.get(url)
```

```python
# BAD: missing await — silently does nothing
async def process():
    save_to_db(data)  # returns coroutine object, never executes

# GOOD
async def process():
    await save_to_db(data)
```

## 3. Error Handling

**Look for:**
- **Bare `except:`** — catches `SystemExit`, `KeyboardInterrupt`, and
  `GeneratorExit`. Always catch specific exceptions or at minimum use
  `except Exception:`.
- **Broad `except Exception:`** — acceptable at top-level boundaries but not
  deep in business logic where specific exceptions should be caught.
- **Swallowed exceptions** — `except: pass` hides failures. At minimum log the
  error.
- **Missing `from` in re-raises** — `raise NewError()` inside an `except` block
  loses the original traceback. Use `raise NewError() from e` to chain.
- **`finally` with `return`** — `return` in `finally` silently swallows
  exceptions from the `try` block.
- **Exception as flow control** — using `try/except KeyError` instead of
  `.get()` or `in` checks for expected conditions. Exceptions should be for
  exceptional cases.
- **Unclosed resources** — files, connections, and locks not managed with `with`
  statements or `contextlib.closing`. Missing cleanup on error paths.

**Severity guidance:**
- Bare `except:` catching system exits: **critical**
- Swallowed exceptions hiding failures: **critical**
- Missing `from` in re-raise: **warning**
- `finally` with `return`: **warning**

**Anti-patterns:**
```python
# BAD: bare except catches KeyboardInterrupt
try:
    process()
except:
    pass

# GOOD: specific exception
try:
    process()
except ValueError as e:
    logger.error("Processing failed: %s", e)
    raise
```

```python
# BAD: lost traceback
try:
    parse(data)
except json.JSONDecodeError:
    raise ValidationError("invalid JSON")

# GOOD: chained exception
try:
    parse(data)
except json.JSONDecodeError as e:
    raise ValidationError("invalid JSON") from e
```

## 4. Python-Specific Performance

**Look for:**
- **String concatenation in loops** — `+=` on strings creates a new object each
  iteration. Use `"".join(parts)` or `io.StringIO` for building strings.
- **List comprehension vs generator** — `sum([x*x for x in range(10**6)])` builds
  the entire list in memory. Use a generator expression:
  `sum(x*x for x in range(10**6))`.
- **Repeated dictionary/attribute lookups in loops** — hoist lookups out of hot
  loops: `get = my_dict.get` before the loop.
- **N+1 queries** — ORM calls inside loops (e.g., `for user in users:
  user.profile.load()`). Use `select_related()` / `prefetch_related()` (Django)
  or equivalent eager loading.
- **Global imports of heavy modules** — importing large modules (pandas, numpy)
  at module level when only used in one rarely-called function. Consider local
  imports for cold paths.
- **Inefficient data structures** — using lists for membership tests (`if x in
  large_list`) instead of sets. `in` on a list is O(n); on a set is O(1).
- **`copy.deepcopy` in hot paths** — deep copy is expensive. Use
  `dataclasses.replace()`, `dict.copy()`, or explicit construction when shallow
  copy suffices.

**Severity guidance:**
- N+1 queries: **warning**
- List where set is needed for lookups: **warning**
- String concatenation in loop: **suggestion**
- Generator vs list comprehension: **suggestion**

## 5. Python-Specific Testing

**Look for:**
- **Mocking too broadly** — `@patch("module.ClassName")` replaces the entire
  class. Patch the specific method or attribute to keep test fidelity.
- **Patching the wrong target** — `@patch("module_under_test.dependency")`
  must patch where the name is looked up, not where it's defined.
- **Missing `assert` in tests** — test functions that call code but never
  assert. The test always passes regardless of behavior.
- **Fixture scope misuse** — `@pytest.fixture(scope="session")` on fixtures
  with mutable state causes cross-test contamination.
- **Not testing exception messages** — `with pytest.raises(ValueError)` without
  `match=` accepts any `ValueError`, even from unrelated code.
- **Parametrize without IDs** — `@pytest.mark.parametrize` without `ids=`
  produces cryptic test names that are hard to debug on failure.

**Severity guidance:**
- Missing assertions in test: **warning**
- Patching wrong target: **warning**
- Fixture scope causing test pollution: **warning**
- Missing `match` on `pytest.raises`: **suggestion**

## 6. Python Style & Conventions

**Look for:**
- **Non-PEP 8 naming** — `camelCase` functions (should be `snake_case`),
  lowercase class names (should be `PascalCase`), non-`UPPER_CASE` constants.
- **Wildcard imports** — `from module import *` pollutes the namespace and makes
  it impossible to trace where names come from.
- **`__init__.py` re-exports without `__all__`** — without `__all__`, `from
  package import *` exports everything, including internal helpers.
- **F-string vs `%` vs `.format()` inconsistency** — pick one style per project
  (f-strings preferred in modern Python). Don't mix within a module.
- **Magic numbers** — unexplained numeric literals. Extract to named constants.
- **Unused imports** — imports that aren't used create false dependencies and
  confuse readers. Tools like `ruff` catch these automatically.
- **`is` vs `==`** — `is` checks identity, `==` checks equality. Use `is` only
  for `None`, `True`, `False` singletons. `x is 1` may work due to interning
  but is not guaranteed.

**Severity guidance:**
- Wildcard imports in production code: **warning**
- Non-PEP 8 naming in new code: **suggestion**
- `is` used for value comparison: **warning**
- Missing `__all__`: **suggestion**

## 7. Security

**Look for:**
- **`eval()` / `exec()`** — arbitrary code execution. Almost never needed. Use
  `ast.literal_eval()` for parsing literals, or structured parsing otherwise.
- **`pickle` with untrusted data** — pickle can execute arbitrary code during
  deserialization. Use JSON, MessagePack, or Protocol Buffers for untrusted
  sources.
- **SQL string formatting** — `f"SELECT * FROM users WHERE id = {user_id}"` is
  SQL injection. Use parameterized queries: `cursor.execute("SELECT ... WHERE
  id = %s", (user_id,))`.
- **`subprocess` with `shell=True`** — command injection risk. Use
  `subprocess.run(["cmd", arg1, arg2])` with a list, never
  `subprocess.run(f"cmd {user_input}", shell=True)`.
- **Hardcoded secrets** — API keys, passwords, tokens in source code. Use
  environment variables or secret managers.
- **`yaml.load()` without `Loader`** — `yaml.load(data)` uses the unsafe
  loader by default in older PyYAML. Always use `yaml.safe_load()`.
- **Path traversal** — `open(user_input)` without sanitization. Validate paths
  with `pathlib.Path.resolve()` and check they stay within the expected
  directory.

**Severity guidance:**
- `eval`/`exec`/`pickle` with untrusted input: **critical**
- SQL injection: **critical**
- `shell=True` with user input: **critical**
- Hardcoded secrets: **critical**
- `yaml.load` without safe loader: **warning**
