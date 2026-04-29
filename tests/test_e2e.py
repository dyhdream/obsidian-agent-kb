"""全链路自测脚本"""
import httpx, time, json, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

BASE = "http://127.0.0.1:9527"
errors = []
warnings = []
optimizations = []

def ok(msg):    print(f"  [OK] {msg}")
def fail(msg):  errors.append(msg); print(f"  [FAIL] {msg}")
def warn(msg):  warnings.append(msg); print(f"  [WARN] {msg}")
def opt(msg):   optimizations.append(msg)

# ── 1. 健康检查 ──
print("\n=== 健康检查 ===")
r = httpx.get(f"{BASE}/health")
if r.status_code == 200 and r.json()["status"] == "ok":
    ok(f"健康, {r.json()['note_count']} 篇笔记")
else:
    fail(f"健康检查失败: {r.status_code}")

# ── 2. 异步分析 — 正常场景 ──
print("\n=== 异步分析 (正常笔记) ===")
body = {"file_path": "test/case1.md", "content": "# Python\nPython is a high-level language. Used for AI, web dev, automation.\n\n## Key Features\n- Simple syntax\n- Rich library\n- Cross platform", "tags": ["python", "programming"]}
r = httpx.post(f"{BASE}/api/analyze/start", json=body, timeout=10)
if r.status_code == 200 and "session_id" in r.json():
    sid = r.json()["session_id"]
    ok(f"启动成功, sid={sid}")
    # 轮询
    found = False
    for i in range(20):
        time.sleep(3)
        rr = httpx.get(f"{BASE}/api/analyze/results/{sid}", timeout=5)
        data = rr.json()
        phase = data.get("phase", "?")
        sugs = len(data.get("suggestions", []))
        done = data.get("done", False)
        print(f"    [{i+1}] {phase:20s} sugs={sugs} done={done}")
        if done:
            found = True
            if sugs > 0:
                ok(f"产出 {sugs} 条建议")
            else:
                warn("分析完成但无建议（可能数据集太小）")
            break
    if not found:
        fail("轮询超时: 60s 内未完成")
else:
    fail(f"启动失败: {r.status_code} {r.text[:200]}")

# ── 3. 异步分析 — 空内容 ──
print("\n=== 异步分析 (空内容) ===")
body = {"file_path": "test/empty.md", "content": "", "tags": []}
r = httpx.post(f"{BASE}/api/analyze/start", json=body, timeout=10)
if r.status_code == 200:
    sid = r.json()["session_id"]
    ok(f"空内容启动成功")
    for i in range(10):
        time.sleep(3)
        rr = httpx.get(f"{BASE}/api/analyze/results/{sid}", timeout=5)
        if rr.json().get("done"):
            ok(f"空内容分析正常完成")
            break
else:
    fail(f"空内容启动失败: {r.status_code}")

# ── 4. 异步分析 — 纯中文 ──
print("\n=== 异步分析 (纯中文) ===")
body = {"file_path": "test/chinese.md", "content": "# 机器学习\n机器学习是人工智能的分支。包括监督学习、无监督学习、强化学习。常用算法有决策树、随机森林、神经网络。", "tags": ["ML", "AI"]}
r = httpx.post(f"{BASE}/api/analyze/start", json=body, timeout=10)
if r.status_code == 200:
    sid = r.json()["session_id"]
    ok(f"中文笔记启动成功")
    for i in range(15):
        time.sleep(3)
        rr = httpx.get(f"{BASE}/api/analyze/results/{sid}", timeout=5)
        data = rr.json()
        if data.get("done"):
            sugs = len(data.get("suggestions", []))
            if sugs > 0:
                ok(f"中文笔记产出 {sugs} 条建议")
            else:
                warn(f"中文笔记无建议")
            break
else:
    fail(f"中文笔记启动失败: {r.status_code}")

# ── 5. 同步分析 ──
print("\n=== 同步分析 ===")
body = {"file_path": "test/sync.md", "content": "Docker is a container runtime. Used for microservices, CI/CD.", "tags": ["docker", "devops"]}
try:
    r = httpx.post(f"{BASE}/api/analyze", json=body, timeout=120)
    if r.status_code == 200:
        data = r.json()
        sugs = data.get("review", {}).get("suggestions", [])
        ok(f"同步分析产出 {len(sugs)} 条 (agent_status: {data['context']['agent_status']})")
    else:
        fail(f"同步分析失败: {r.status_code}")
except Exception as e:
    fail(f"同步分析异常: {e}")

# ── 6. Split ──
print("\n=== 笔记拆分 ===")
body = {"file_path": "test/split.md", "content": "# Full Stack\n\n## Frontend\nReact is a UI library.\n\n## Backend\nFastAPI is a Python web framework.\n\n## Database\nPostgreSQL is a relational database.", "topics": ["Frontend", "Backend", "Database"]}
try:
    r = httpx.post(f"{BASE}/api/split", json=body, timeout=60)
    if r.status_code == 200:
        data = r.json()
        files = data.get("files", [])
        ok(f"拆分产出 {len(files)} 个子笔记")
    else:
        fail(f"拆分失败: {r.status_code}")
except Exception as e:
    fail(f"拆分异常: {e}")

# ── 7. Usage ──
print("\n=== 用量统计 ===")
r = httpx.get(f"{BASE}/api/usage", timeout=5)
if r.status_code == 200:
    data = r.json()
    today = data["today"]
    ok(f"今日: {today['calls']} 次调用, {today['total_tokens']} tokens, ¥{today['total_cost_rmb']}")
else:
    fail(f"用量失败: {r.status_code}")

# ── 8. Feedback ──
print("\n=== 反馈记录 ===")
for i in range(3):
    r = httpx.post(f"{BASE}/api/feedback", json={"action_type": "link", "suggestion": f"test-{i}", "accepted": i % 2 == 0}, timeout=5)
    if r.status_code != 200:
        fail(f"反馈失败: {r.status_code}")
        break
else:
    ok("3 条反馈记录成功")

# ── 9. 不存在的 session_id ──
print("\n=== 不存在 session_id ===")
r = httpx.get(f"{BASE}/api/analyze/results/fake-123", timeout=5)
data = r.json()
if data.get("done") and data.get("status") == "not_found":
    ok("不存在 session 正确返回 not_found")
else:
    warn(f"不存在 session 返回: {data}")

# ── 10. 特殊字符 ──
print("\n=== 特殊字符内容 ===")
body = {"file_path": "test/special.md", "content": "C++ has pointers & references.\nvoid foo(int *p) { (*p)++; }\n\nKey: value with \"quotes\" and <tags>", "tags": ["c++"]}
r = httpx.post(f"{BASE}/api/analyze/start", json=body, timeout=10)
if r.status_code == 200:
    sid = r.json()["session_id"]
    ok("特殊字符启动成功")
    for i in range(12):
        time.sleep(3)
        rr = httpx.get(f"{BASE}/api/analyze/results/{sid}", timeout=5)
        if rr.json().get("done"):
            ok("特殊字符分析完成")
            break
else:
    fail(f"特殊字符启动失败: {r.status_code}")

# ── 汇总 ──
print("\n" + "="*50)
print(f"测试完成: {len(errors)} 错误, {len(warnings)} 警告, {len(optimizations)} 优化建议")
print("="*50)

if errors:
    print("\n[ERRORS]:")
    for e in errors:
        print(f"  - {e}")

if warnings:
    print("\n[WARNINGS]:")
    for w in warnings:
        print(f"  - {w}")

if optimizations:
    print("\n[OPTIMIZATIONS]:")
    for o in optimizations:
        print(f"  - {o}")
