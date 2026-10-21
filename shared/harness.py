# Runs one Python code card. Shared by the local runner (server/exec.mjs) and the
# in-browser Pyodide runner (client/src/py-worker.js), so both behave the same:
#   - the value of a trailing expression is shown, like a notebook cell
#   - tracebacks only mention the card's own lines
#   - matplotlib figures are returned as PNG images
import ast, base64, io, json, linecache, math, os, sys, traceback
from numbers import Real

os.environ.setdefault("MPLBACKEND", "Agg")
_MARK = "\x1e"


def _quanta_emit(kind, payload):
    sys.stdout.flush()
    sys.__stdout__.write(_MARK + kind + ":" + payload + "\n")
    sys.__stdout__.flush()


def _quanta_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buffer = io.BytesIO()
        fig.savefig(buffer, format="png", dpi=110, bbox_inches="tight")
        _quanta_emit("IMG", base64.b64encode(buffer.getvalue()).decode("ascii"))
    plt.close("all")


def _quanta_series(value):
    np = sys.modules.get("numpy")
    if np is not None and isinstance(value, np.ndarray):
        if value.ndim != 1:
            return
    elif not isinstance(value, (list, tuple)):
        return
    count = len(value)
    if not 2 <= count <= 100000:
        return
    if any(isinstance(v, bool) or not isinstance(v, Real) or not math.isfinite(v) for v in value):
        return
    size = min(256, count)
    points = [[round(i * (count - 1) / (size - 1)), float(value[round(i * (count - 1) / (size - 1))])] for i in range(size)]
    _quanta_emit("SERIES", json.dumps(points, allow_nan=False))


def _quanta_run(source):
    name = "<card>"
    linecache.cache[name] = (len(source), None, source.splitlines(True), name)
    namespace = {"__name__": "__main__", "__builtins__": __builtins__}
    ok = True
    try:
        tree = ast.parse(source, name, "exec")
        last = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last = ast.Expression(tree.body.pop().value)
        exec(compile(tree, name, "exec"), namespace)
        if last is not None:
            value = eval(compile(last, name, "eval"), namespace)
            if value is not None:
                _quanta_emit("VAL", json.dumps(repr(value)[:20000]))
                try:
                    _quanta_series(value)
                except (TypeError, ValueError, OverflowError):
                    pass  # a preview must never turn successful code into an error
    except SystemExit:
        pass
    except BaseException:
        ok = False
        kind, error, tb = sys.exc_info()
        frames = [frame for frame in traceback.extract_tb(tb) if frame.filename == name]
        text = "".join(traceback.format_exception_only(kind, error))
        if frames:
            text = "Traceback (most recent call last):\n" + "".join(traceback.format_list(frames)) + text
        sys.stdout.flush()
        sys.stderr.write(text)
        sys.stderr.flush()
    try:
        _quanta_figures()
    except Exception as error:  # a broken figure should not hide the output
        sys.stderr.write(f"Could not render figure: {error}\n")
    return ok
