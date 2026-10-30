(function () {
  var id = window.__SIGN_ID__;
  var statusEl = document.getElementById("status");
  var warnEl = document.getElementById("warn");
  var summaryEl = document.getElementById("summary");
  var resultEl = document.getElementById("result");
  var connectBtn = document.getElementById("connect");
  var approveBtn = document.getElementById("approve");

  function status(t) { statusEl.textContent = t; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }
  function detectL1() {
    if (window.kasware) return { name: "KasWare", api: "kasware" };
    if (window.kastle) return { name: "Kastle", api: "kastle" };
    return null;
  }
  function renderSummary(derived) {
    summaryEl.innerHTML = (derived.lines || []).map(function (l) {
      return "<dt>" + escapeHtml(l.label) + "</dt><dd>" + escapeHtml(l.value) + "</dd>";
    }).join("");
    if (derived.warnings && derived.warnings.length) {
      warnEl.hidden = false;
      warnEl.textContent = derived.warnings.join(" ");
    }
    status(derived.title || "Ready");
  }

  var session = null;
  var built = null;

  function fetchBody() {
    if (window.__SIGN_BOOTSTRAP__ && window.__SIGN_BOOTSTRAP__.session) {
      return Promise.resolve(window.__SIGN_BOOTSTRAP__);
    }
    return fetch("/api/sign/" + id).then(function (res) {
      return res.text().then(function (text) {
        var body;
        try { body = JSON.parse(text); } catch (e) {
          throw new Error("Bad /api/sign response: " + text.slice(0, 80));
        }
        if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
        return body;
      });
    });
  }

  function load() {
    return fetchBody().then(function (body) {
      if (body.error) throw new Error(body.error);
      session = body.session;
      if (!session) throw new Error("Unknown or expired sign session");
      if (session.l1Build && session.l1Build.buildInBrowser) {
        status("Building transaction in browser (kaspa-wasm)…");
        return import("/sign/l1-build.js").then(function (mod) {
          var p =
            session.kind === "l1-fund"
              ? mod.buildFundTx(session.l1Build)
              : mod.buildSpendTx(session.l1Build);
          return p.then(function (b) {
            built = b;
            var title =
              session.kind === "l1-fund"
                ? "Fund covenant on " + session.networkLabel
                : "Spend covenant on " + session.networkLabel;
            var json = b.signedSafeJson || b.safeJson;
            var derived = mod.summarizeBuiltSafeJson(json, {
              title: title,
              networkLabel: session.networkLabel,
              isMainnet: session.isMainnet,
            });
            if (b.p2shAddress) derived.lines.unshift({ label: "P2SH", value: b.p2shAddress });
            if (b.mode === "unsigned_needs_unlock") {
              derived.warnings = (derived.warnings || []).concat([b.note || "Unlock not filled"]);
            }
            renderSummary(derived);
            connectBtn.disabled = false;
          }).catch(function (e) {
            status("Build failed: " + (e && e.message || e));
            throw e;
          });
        }).catch(function (e) {
          status("Build failed: " + (e && e.message || e));
          throw e;
        });
      }
      if (body.summary) renderSummary(body.summary);
      built = {
        safeJson: session.safeJson,
        signedSafeJson: session.signedSafeJson,
        signInputs: session.signInputs,
      };
      connectBtn.disabled = false;
    });
  }

  function connect() {
    if (!session) return Promise.resolve();
    if (session.kind === "l1-fund" || session.kind === "l1-spend") {
      var w = detectL1();
      if (!w) return Promise.reject(new Error("Install KasWare or open in KasWare/Kastle in-app browser"));
      if (w.api === "kasware") {
        return window.kasware.requestAccounts().then(function (accounts) {
          return window.kasware.getNetwork().catch(function () { return ""; }).then(function (net) {
            status("Connected KasWare: " + (accounts[0] || "") + " · " + net);
            approveBtn.disabled = false;
          });
        });
      }
      var p = typeof window.kastle.connect === "function" ? window.kastle.connect() : Promise.resolve();
      return p.then(function () {
        status("Connected Kastle");
        approveBtn.disabled = false;
      });
    }
    if (!window.ethereum) return Promise.reject(new Error("No injected EVM wallet"));
    return window.ethereum.request({ method: "eth_requestAccounts" }).then(function () {
      status("Connected EVM wallet");
      approveBtn.disabled = false;
    });
  }

  function approveL1() {
    var w = detectL1();
    if (!w) return Promise.reject(new Error("No L1 wallet"));
    var signed = built && built.signedSafeJson;
    if (signed) {
      if (w.api === "kasware") return window.kasware.pushTx(signed);
      if (window.kastle && window.kastle.signAndBroadcastTx) {
        return Promise.resolve(window.kastle.getNetwork ? window.kastle.getNetwork() : session.networkId).then(
          function (net) { return window.kastle.signAndBroadcastTx(net, signed); },
        );
      }
    }
    var json = built && built.safeJson;
    if (!json) return Promise.reject(new Error("Missing SafeJSON — build failed"));
    if (w.api === "kasware") {
      var opts =
        built.signInputs && built.signInputs.length ? { signInputs: built.signInputs } : undefined;
      return window.kasware.signPskt({ txJsonString: json, options: opts }).then(function (s) {
        return window.kasware.pushTx(s);
      });
    }
    return Promise.resolve(window.kastle.getNetwork ? window.kastle.getNetwork() : "testnet-10").then(
      function (net) {
        if (typeof window.kastle.signAndBroadcastTx === "function") {
          return window.kastle.signAndBroadcastTx(net, json);
        }
        throw new Error("Unsupported Kastle API");
      },
    );
  }

  function approveEvm() {
    if (!window.ethereum || !session.evm) return Promise.reject(new Error("No EVM session"));
    var tx = {
      to: session.evm.to || undefined,
      data: session.evm.data,
      value:
        session.evm.value && session.evm.value !== "0"
          ? "0x" + BigInt(session.evm.value).toString(16)
          : undefined,
      gas: session.evm.gasLimit ? "0x" + BigInt(session.evm.gasLimit).toString(16) : undefined,
      gasPrice: session.evm.gasPrice ? "0x" + BigInt(session.evm.gasPrice).toString(16) : undefined,
    };
    return window.ethereum.request({ method: "eth_sendTransaction", params: [tx] });
  }

  function approve() {
    status("Approve in your wallet…");
    var p = session.kind === "l1-fund" || session.kind === "l1-spend" ? approveL1() : approveEvm();
    return p.then(function (txid) {
      return fetch("/api/sign/" + id + "/explorer?txid=" + encodeURIComponent(txid))
        .then(function (r) { return r.json(); })
        .then(function (body) {
          var exp = body.url || String(txid);
          status("Submitted");
          resultEl.hidden = false;
          resultEl.innerHTML =
            "txid: " +
            escapeHtml(txid) +
            "<br/><a href=\"" +
            escapeHtml(exp) +
            "\" target=\"_blank\" rel=\"noopener\">Open explorer</a>";
        });
    });
  }

  connectBtn.addEventListener("click", function () {
    connect().catch(function (e) { status("Connect failed: " + (e && e.message || e)); });
  });
  approveBtn.addEventListener("click", function () {
    approve().catch(function (e) { status("Approve failed: " + (e && e.message || e)); });
  });
  load().catch(function (e) { status("Load failed: " + (e && e.message || e)); });
})();
