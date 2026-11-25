import json
import re
import subprocess
import threading
import time

from harness import MCPTestClient, TEST_ENV

class SequenceCases:
    def test_call_tool_sequence_click_link(self):
        print("--- Running Test: Call Tool - Browse Sequence Click Link ---")
        html = """<!doctype html>
<html>
<body>
  <a href="#" onclick="document.getElementById('result').textContent = 'clicked'; return false;">Click target</a>
  <p id="result">waiting</p>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                {"type": "click", "selector": "a[href]"}
            ],
            "maxChars": 2000,
            "includeNetwork": True
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert payload["actions"][0]["status"] == "ok"
        assert "clicked" in payload["text"], f"Expected click side effect: {payload}"
        assert payload["status"] and payload["status"] < 400
        assert payload.get("diagnostics", {}).get("network")
        print("CallTool sequence click link test passed.")

    def test_call_tool_sequence_click_auto_pointer_path(self):
        print("--- Running Test: Call Tool - Browse Sequence Click Auto Pointer Path ---")
        html = """<!doctype html>
<html>
<body>
  <button id="target">Click target</button>
  <p id="result">waiting</p>
  <script>
    const target = document.getElementById('target');
    let pointerStarted = false;
    target.addEventListener('pointerdown', () => { pointerStarted = true; });
    target.addEventListener('mousedown', () => { pointerStarted = true; });
    target.addEventListener('click', () => {
      document.getElementById('result').textContent = pointerStarted ? 'pointer clicked' : 'dom clicked';
    });
  </script>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                # See the fallback case below for why the timeout is generous.
                {"type": "click", "selector": "#target", "clickMode": "auto", "timeout": 6000}
            ],
            "maxChars": 2000
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert payload["actions"][0]["status"] == "ok"
        assert "pointer clicked" in payload["text"] or "dom clicked" in payload["text"], f"Expected auto click side effect: {payload}"
        print("CallTool sequence click auto pointer path test passed.")

    def test_call_tool_sequence_click_auto_falls_back_to_dom(self):
        print("--- Running Test: Call Tool - Browse Sequence Click Auto Falls Back To DOM ---")
        html = """<!doctype html>
<html>
<head>
  <style>
    #target { position: absolute; left: 20px; top: 20px; width: 180px; height: 60px; }
    #cover { position: absolute; left: 0; top: 0; width: 260px; height: 120px; z-index: 10; background: rgba(0, 0, 0, 0.01); }
    #result { position: absolute; top: 140px; }
  </style>
</head>
<body>
  <button id="target" onclick="document.getElementById('result').textContent = 'clicked';">Click target</button>
  <div id="cover"></div>
  <p id="result">waiting</p>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                # One timeout covers the pointer trial and the DOM click. The
                # trial may use half of it, and under Xvfb it never passes. The
                # DOM click then took up to about 0.7 s in measurement, more
                # than a 1 s timeout leaves it.
                {"type": "click", "selector": "#target", "clickMode": "auto", "timeout": 6000}
            ],
            "maxChars": 2000
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert payload["actions"][0]["status"] == "ok"
        assert "clicked" in payload["text"], f"Expected DOM fallback side effect: {payload}"
        print("CallTool sequence click auto fallback test passed.")

    def test_call_tool_sequence_form_actions(self):
        print("--- Running Test: Call Tool - Browse Sequence Form Actions ---")
        html = """<!doctype html>
<html>
<body>
  <label>Name <input id="name-field" aria-label="Name"></label>
  <label>Notes <textarea id="notes-field" aria-label="Notes"></textarea></label>
  <label>Choice <select id="choice-field" aria-label="Choice"><option value="alpha">Alpha</option><option value="beta">Beta</option></select></label>
  <p id="summary">empty</p>
  <script>
    const nameField = document.getElementById('name-field');
    const notesField = document.getElementById('notes-field');
    const choiceField = document.getElementById('choice-field');
    const summary = document.getElementById('summary');
    function update() {
      summary.textContent = `name ${nameField.value} notes ${notesField.value} choice ${choiceField.value}`;
    }
    nameField.addEventListener('input', update);
    notesField.addEventListener('input', update);
    choiceField.addEventListener('change', update);
  </script>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                {"type": "fill", "selector": "#name-field", "value": "Alice"},
                {"type": "type", "selector": "#notes-field", "text": "hello"},
                {"type": "select", "selector": "#choice-field", "value": "beta"},
                {"type": "waitFor", "selector": "#summary"}
            ],
            "maxChars": 2000,
            "maxElements": 20
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert len(payload["actions"]) == 4
        assert all(action["status"] == "ok" for action in payload["actions"])
        assert "name Alice notes hello choice beta" in payload["text"]
        assert payload["snapshot"]["elements"], f"Expected final snapshot elements: {payload}"
        print("CallTool sequence form actions test passed.")

    def test_call_tool_sequence_rejects_timeout_budget(self):
        print("--- Running Test: Call Tool - Browse Sequence Rejects Timeout Budget ---")
        response = self._call_tool("browse_sequence", {
            "url": "https://example.com",
            # 5 x 60000 = 300000ms, above the 250000ms default budget
            # (CAMOUFOX_MCP_SEQUENCE_TIMEOUT_MS) with the max per-action timeout.
            "actions": [
                {"type": "waitFor", "timeout": 60000},
                {"type": "waitFor", "timeout": 60000},
                {"type": "waitFor", "timeout": 60000},
                {"type": "waitFor", "timeout": 60000},
                {"type": "waitFor", "timeout": 60000}
            ]
        }, timeout=10)
        assert response and response.get("result", {}).get("isError"), response
        assert "Sequence timeout budget exceeds server policy" in self.get_tool_text(response), response
        print("CallTool sequence timeout budget rejection test passed.")


    def test_call_tool_sequence_scrolls_selector_element(self):
        print("--- Running Test: Call Tool - Browse Sequence Scroll Selector Element ---")
        html = """<!doctype html>
<html>
<body>
  <div id="box" style="height:50px;width:200px;overflow:auto;border:1px solid black"
       onscroll="document.getElementById('result').textContent = 'scrollTop ' + this.scrollTop;">
    <div style="height:500px">scroll content</div>
  </div>
  <p id="result">scrollTop 0</p>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                {"type": "scroll", "selector": "#box", "deltaY": 180}
            ],
            "maxChars": 2000
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert payload["actions"][0]["status"] == "ok"
        assert "scrollTop 0" not in payload["text"], f"Expected selected element to scroll: {payload}"
        assert "scrollTop " in payload["text"], f"Expected scroll result text: {payload}"
        print("CallTool sequence selector scroll test passed.")

    def test_call_tool_sequence_rejects_private_redirect(self):
        print("--- Running Test: Call Tool - Browse Sequence Reject Private Redirect ---")
        response = self._call_tool("browse_sequence", {
            "url": self._url("/redirect-to?url=http%3A%2F%2F127.0.0.1%3A80"),
            "actions": []
        }, timeout=30)
        assert response and response.get("result", {}).get("isError"), f"Private sequence redirect was not rejected: {response}"
        assert "blocked unsafe browser request" in self.get_tool_text(response).lower()
        print("CallTool sequence private redirect rejection test passed.")

    def test_call_tool_sequence_failure_reports_private_host_policy(self):
        print("--- Running Test: Sequence Failure Reports Private Host Policy ---")
        # The request is issued after the first action's guard check, and the
        # browser may hold it for seconds. The second action therefore waits on
        # the request itself: the disabled control appears only once the fetch
        # has settled, and clicking a disabled control fails at once.
        html = """<!doctype html>
<html>
<body>
  <button id="arm" onclick="setTimeout(() => fetch('http://blocked.localhost:80/private?token=sequence-policy-secret#fragment').catch(() => {}).finally(() => { document.getElementById('settled').hidden = false; }), 1500)">Arm request</button>
  <button id="settled" disabled hidden>Request settled</button>
</body>
</html>"""
        response = self._call_tool("browse_sequence", {
            "url": self._fixture_url(html),
            "actions": [
                {"type": "click", "selector": "#arm"},
                {"type": "click", "selector": "#settled", "timeout": 30000},
            ],
            "geoip": False,
        }, timeout=90)
        assert response and response.get("result", {}).get("isError"), response
        error = self.get_tool_text(response)
        assert "blocked unsafe browser request" in error.lower(), response
        assert "CAMOUFOX_MCP_ALLOWED_PRIVATE_HOSTS=blocked.localhost" in error, response
        assert "restart" in error.lower(), response
        assert "sequence-policy-secret" not in error and "#fragment" not in error, response
        print("Sequence failed-action policy guidance test passed.")

    def test_call_tool_sequence_rejects_evaluate_by_default(self):
        print("--- Running Test: Call Tool - Browse Sequence Reject Evaluate By Default ---")
        response = self._call_tool("browse_sequence", {
            "url": self._example_url(),
            "actions": [
                {"type": "evaluate", "expression": "document.title"}
            ]
        }, timeout=60)
        assert response and response.get("result", {}).get("isError"), f"Evaluate action was not rejected: {response}"
        assert "evaluate action is disabled" in self.get_tool_text(response).lower()
        print("CallTool sequence evaluate rejection test passed.")

    def test_call_tool_sequence_drag_slider_handle(self):
        print("--- Running Test: Call Tool - Browse Sequence Drag Slider Handle ---")
        # A pointer-event slider: the handle only follows real pointer input,
        # and the result records the final pointerup position and how many
        # pointermove events the drag produced.
        html = """<!doctype html>
<html>
<body style="margin:0">
  <div id="track" style="position:absolute;left:0;top:0;width:400px;height:40px;background:#ddd">
    <div id="handle" style="position:absolute;left:20px;top:5px;width:30px;height:30px;background:blue"></div>
  </div>
  <p id="result" style="position:absolute;top:60px">none</p>
  <script>
    const handle = document.getElementById('handle');
    const result = document.getElementById('result');
    let dragging = false, startX = 0, startLeft = 0, moves = 0;
    handle.addEventListener('pointerdown', (e) => {
      dragging = true; startX = e.clientX; startLeft = parseInt(handle.style.left) || 0; moves = 0;
      e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => {
      if (dragging) { moves += 1; handle.style.left = (startLeft + e.clientX - startX) + 'px'; }
    });
    window.addEventListener('pointerup', (e) => {
      if (dragging) { dragging = false; result.textContent = 'drag ' + (startLeft + e.clientX - startX) + ' moves ' + moves; }
    });
  </script>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                {"type": "drag", "selector": "#handle", "deltaX": 120, "deltaY": 0, "timeout": 8000}
            ],
            "maxChars": 2000
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert payload["actions"][0]["status"] == "ok", payload
        assert payload["actions"][0]["type"] == "drag"
        # Handle center is x=35; +120 px lands the pointerup at x=155, so the
        # handle moves 20 -> 140. The humanized path emits 40-80 moves.
        assert "drag 140" in payload["text"], f"Expected the slider to follow the drag: {payload}"
        match = re.search(r"moves (\d+)", payload["text"])
        assert match and 40 <= int(match.group(1)) <= 80, f"Expected 40-80 pointermove events: {payload}"
        print("CallTool sequence drag slider handle test passed.")

    def test_call_tool_sequence_drag_coordinates_to_target(self):
        print("--- Running Test: Call Tool - Browse Sequence Drag Coordinates To Target ---")
        html = """<!doctype html>
<html>
<body style="margin:0">
  <canvas id="pad" width="400" height="400" style="position:absolute;left:0;top:0"></canvas>
  <p id="result" style="position:absolute;top:420px">none</p>
  <script>
    const pad = document.getElementById('pad');
    const result = document.getElementById('result');
    let dragging = false, last = null;
    pad.addEventListener('pointerdown', (e) => { dragging = true; last = [e.clientX, e.clientY]; });
    pad.addEventListener('pointermove', (e) => { if (dragging) last = [e.clientX, e.clientY]; });
    pad.addEventListener('pointerup', (e) => {
      if (dragging) { dragging = false; result.textContent = 'drop ' + e.clientX + ' ' + e.clientY + ' from ' + last[0] + ' ' + last[1]; }
    });
  </script>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                {"type": "drag", "from": {"x": 30, "y": 30}, "to": {"x": 250, "y": 200}, "timeout": 8000}
            ],
            "maxChars": 2000
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert payload["actions"][0]["status"] == "ok", payload
        assert "drop 250 200" in payload["text"], f"Expected the coordinate drag to end on target: {payload}"
        print("CallTool sequence drag coordinates test passed.")

    def test_call_tool_sequence_click_at_canvas_widget(self):
        print("--- Running Test: Call Tool - Browse Sequence ClickAt Canvas Widget ---")
        # A canvas-only widget: no DOM element receives a click handler, only
        # pointer events on the canvas record the press.
        html = """<!doctype html>
<html>
<body style="margin:0">
  <canvas id="pad" width="300" height="300" style="position:absolute;left:0;top:0"></canvas>
  <p id="result" style="position:absolute;top:320px">none</p>
  <script>
    const pad = document.getElementById('pad');
    const result = document.getElementById('result');
    let downAt = null;
    pad.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
    pad.addEventListener('pointerup', (e) => {
      if (downAt) result.textContent = 'click down ' + downAt[0] + ' ' + downAt[1] + ' up ' + e.clientX + ' ' + e.clientY;
    });
  </script>
</body>
</html>"""
        response = self._run_sequence({
            "url": self._fixture_url(html),
            "actions": [
                {"type": "clickAt", "x": 100, "y": 120, "timeout": 5000}
            ],
            "maxChars": 2000
        }, timeout=90)
        payload = self.get_tool_payload(response)
        assert payload["actions"][0]["status"] == "ok", payload
        assert payload["actions"][0]["type"] == "clickAt"
        match = re.search(r"click down (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) up (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)", payload["text"])
        assert match, f"Expected a pointerdown+pointerup pair: {payload}"
        down_x, down_y, up_x, up_y = (float(g) for g in match.groups())
        assert abs(down_x - 100) <= 3 and abs(down_y - 120) <= 3, f"pointerdown near the requested coordinate: {payload['text']}"
        assert abs(up_x - 100) <= 3 and abs(up_y - 120) <= 3, f"pointerup near the requested coordinate: {payload['text']}"
        print("CallTool sequence clickAt canvas widget test passed.")

    def test_call_tool_sequence_rejects_invalid_drag(self):
        print("--- Running Test: Call Tool - Browse Sequence Rejects Invalid Drag ---")
        response = self._call_tool("browse_sequence", {
            "url": self._example_url(),
            "actions": [{"type": "drag", "from": {"x": 1, "y": 2}}]
        }, timeout=30)
        assert response and response.get("result", {}).get("isError"), f"Invalid drag was not rejected: {response}"
        response = self._call_tool("browse_sequence", {
            "url": self._example_url(),
            "actions": [{"type": "drag", "selector": "#a"}]
        }, timeout=30)
        assert response and response.get("result", {}).get("isError"), f"Destination-less drag was not rejected: {response}"
        print("CallTool sequence invalid drag rejection test passed.")
