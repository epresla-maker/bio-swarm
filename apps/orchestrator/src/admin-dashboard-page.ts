export function renderAdminDashboardPage(): string {
	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="utf-8" />
		<meta name="viewport" content="width=device-width,initial-scale=1" />
		<title>Bio Swarm Admin Dashboard</title>
		<style>
			:root {
				--bg-0: #061423;
				--bg-1: #0f2a42;
				--bg-2: #153a5b;
				--card: #f6fbff;
				--ink: #0c1d2e;
				--muted: #4a6076;
				--warn: #d9480f;
				--ok: #2f9e44;
				--line: #d4e4f2;
				--accent: #0ea5e9;
			}

			* {
				box-sizing: border-box;
			}

			body {
				margin: 0;
				min-height: 100vh;
				font-family: "Avenir Next", "Segoe UI", sans-serif;
				background: radial-gradient(circle at 20% 15%, #1f4b73 0%, transparent 35%),
					radial-gradient(circle at 85% 80%, #1a6f8f 0%, transparent 30%),
					linear-gradient(140deg, var(--bg-0), var(--bg-1) 60%, var(--bg-2));
				color: #eaf5ff;
			}

			.wrap {
				max-width: 1180px;
				margin: 0 auto;
				padding: 24px 16px 48px;
			}

			.hero {
				display: flex;
				flex-wrap: wrap;
				gap: 14px;
				align-items: center;
				justify-content: space-between;
				margin-bottom: 18px;
			}

			.title {
				margin: 0;
				font-size: clamp(1.5rem, 4vw, 2.4rem);
				letter-spacing: 0.03em;
			}

			.subtitle {
				margin: 4px 0 0;
				color: #c6def3;
			}

			.controls {
				display: flex;
				gap: 8px;
				flex-wrap: wrap;
			}

			.input,
			.button {
				border-radius: 12px;
				border: 1px solid rgba(255, 255, 255, 0.25);
				padding: 10px 12px;
				font: inherit;
			}

			.input {
				background: rgba(8, 22, 35, 0.45);
				color: #fff;
				min-width: 260px;
			}

			.button {
				background: linear-gradient(90deg, #22c55e, #0ea5e9);
				color: #062019;
				font-weight: 700;
				cursor: pointer;
			}

			.grid {
				display: grid;
				grid-template-columns: repeat(12, minmax(0, 1fr));
				gap: 12px;
			}

			.card {
				background: var(--card);
				color: var(--ink);
				border-radius: 16px;
				border: 1px solid var(--line);
				padding: 14px;
			}

			.kpi {
				grid-column: span 6;
			}

			.wide {
				grid-column: span 12;
			}

			.half {
				grid-column: span 6;
			}

			h2,
			h3 {
				margin: 0 0 8px;
			}

			.row {
				display: flex;
				justify-content: space-between;
				gap: 8px;
				padding: 6px 0;
				border-bottom: 1px solid #e7f0f8;
			}

			.row:last-child {
				border-bottom: 0;
			}

			.badge {
				border-radius: 999px;
				padding: 4px 8px;
				font-size: 0.8rem;
				font-weight: 700;
			}

			.badge.warn {
				background: #ffe8cc;
				color: var(--warn);
			}

			.badge.ok {
				background: #d3f9d8;
				color: var(--ok);
			}

			.mono {
				font-family: ui-monospace, Menlo, monospace;
				font-size: 0.82rem;
				color: var(--muted);
			}

			.status {
				margin: 8px 0 12px;
				min-height: 20px;
				color: #d9ecff;
			}

			@media (max-width: 900px) {
				.kpi,
				.half,
				.wide {
					grid-column: span 12;
				}
			}
		</style>
	</head>
	<body>
		<main class="wrap">
			<section class="hero">
				<div>
					<h1 class="title">Bio Swarm Operator Console</h1>
					<p class="subtitle">Live attention view from /admin/dashboard</p>
				</div>
				<div class="controls">
					<input id="key" class="input" type="password" placeholder="Admin API key" />
					<button id="refresh" class="button" type="button">Refresh</button>
				</div>
			</section>

			<p id="status" class="status"></p>

			<section class="grid">
				<article class="card kpi">
					<h2>Task Summary</h2>
					<div id="taskSummary"></div>
				</article>

				<article class="card kpi">
					<h2>Node Summary</h2>
					<div id="nodeSummary"></div>
				</article>

				<article class="card half">
					<h3>Attention Tasks</h3>
					<div id="attentionTasks"></div>
				</article>

				<article class="card half">
					<h3>Attention Nodes</h3>
					<div id="attentionNodes"></div>
				</article>

				<article class="card wide">
					<h3>Recent Audit</h3>
					<div id="recentAudit"></div>
				</article>
			</section>
		</main>

		<script>
			const els = {
				key: document.getElementById("key"),
				refresh: document.getElementById("refresh"),
				status: document.getElementById("status"),
				taskSummary: document.getElementById("taskSummary"),
				nodeSummary: document.getElementById("nodeSummary"),
				attentionTasks: document.getElementById("attentionTasks"),
				attentionNodes: document.getElementById("attentionNodes"),
				recentAudit: document.getElementById("recentAudit")
			};

			function row(label, value, badgeClass) {
				const badge = badgeClass ? '<span class="badge ' + badgeClass + '">' + value + '</span>' : String(value);
				return '<div class="row"><span>' + label + '</span><span>' + badge + '</span></div>';
			}

			function age(ms) {
				if (ms === null || ms === undefined) return "n/a";
				if (ms < 1000) return ms + " ms";
				const seconds = Math.floor(ms / 1000);
				if (seconds < 60) return seconds + " s";
				return Math.floor(seconds / 60) + " min";
			}

			function renderDashboard(data) {
				els.taskSummary.innerHTML = [
					row("Total", data.tasks.total),
					row("Pending", data.tasks.pending),
					row("Leased", data.tasks.leased),
					row("Completed", data.tasks.completed, "ok"),
					row("Failed", data.tasks.failed, "warn")
				].join("");

				els.nodeSummary.innerHTML = [
					row("Total", data.nodes.total),
					row("Active", data.nodes.active),
					row("Enabled", data.nodes.enabled, "ok"),
					row("Disabled", data.nodes.disabled, data.nodes.disabled > 0 ? "warn" : "ok"),
					row("Quarantined", data.nodes.quarantined, data.nodes.quarantined > 0 ? "warn" : "ok")
				].join("");

				els.attentionTasks.innerHTML = data.attentionTasks.length
					? data.attentionTasks
							.map(
								(item) =>
									'<div class="row"><div><strong>' + item.snapshot.task.id.slice(0, 8) + '</strong><div class="mono">' +
									item.reason +
									' | attempts=' + item.details.attempts + ' | results=' + item.details.resultCount + ' | age=' + age(item.details.ageMs) +
									'</div></div></div>'
							)
							.join("")
					: '<div class="mono">No attention tasks.</div>';

				els.attentionNodes.innerHTML = data.attentionNodes.length
					? data.attentionNodes
							.map(
								(item) =>
									'<div class="row"><div><strong>' + item.snapshot.stats.nodeId + '</strong><div class="mono">' +
									item.reason +
									' | rej=' + item.details.rejected + ' | acc=' + item.details.accepted + ' | rejRate=' +
									Math.round(item.details.rejectionRate * 100) + '% | seen=' + age(item.details.lastSeenAgeMs) + '</div></div></div>'
							)
							.join("")
					: '<div class="mono">No attention nodes.</div>';

				els.recentAudit.innerHTML = data.recentAudit.length
					? data.recentAudit
							.map(
								(item) =>
									'<div class="row"><div><strong>' + item.eventType + '</strong><div class="mono">' +
									item.at +
									(item.taskId ? ' | task=' + item.taskId : '') +
									(item.nodeId ? ' | node=' + item.nodeId : '') +
									'</div></div></div>'
							)
							.join("")
					: '<div class="mono">No audit entries.</div>';
			}

			async function loadDashboard() {
				const key = els.key.value.trim();
				if (!key) {
					els.status.textContent = "Enter admin API key first.";
					return;
				}

				els.status.textContent = "Loading dashboard...";

				try {
					const response = await fetch("/admin/dashboard", {
						headers: {
							"x-admin-key": key
						}
					});

					if (!response.ok) {
						const text = await response.text();
						els.status.textContent = "Dashboard fetch failed: " + response.status + " " + text;
						return;
					}

					const payload = await response.json();
					renderDashboard(payload);
					els.status.textContent = "Updated at " + new Date().toLocaleTimeString();
				} catch (error) {
					els.status.textContent = "Request failed: " + error;
				}
			}

			els.refresh.addEventListener("click", loadDashboard);
			els.key.addEventListener("keydown", (event) => {
				if (event.key === "Enter") {
					loadDashboard();
				}
			});
		</script>
	</body>
</html>`;
}
