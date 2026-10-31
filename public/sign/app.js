(function () {
  var id = window.__SIGN_ID__;
  var statusEl = document.getElementById("status");
  var warnEl = document.getElementById("warn");
  var plainEl = document.getElementById("plain");
  var summaryEl = document.getElementById("summary");
  var badgeEl = document.getElementById("badge");
  var headlineEl = document.getElementById("headline");
  var contractEl = document.getElementById("contract");
  var resultEl = document.getElementById("result");
  var connectBtn = document.getElementById("connect");
  var approveBtn = document.getElementById("approve");
  var l1Mod = null;

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
    if (headlineEl) headlineEl.textContent = derived.title || "Tap to approve";
    if (badgeEl) {
      badgeEl.hidden = false;
      badgeEl.textContent = derived.networkBadge || (session && session.isMainnet ? "Mainnet" : "Testnet");
      badgeEl.className = "badge " + ((derived.networkBadge || "").toLowerCase() === "mainnet" || (session && session.isMainnet) ? "mainnet" : "testnet");
    }
    if (contractEl) {
      if (derived.contractName) {
        contractEl.hidden = false;
        contractEl.textContent = derived.contractName;
      } else {
        contractEl.hidden = true;
      }
    }
    if (plainEl) {
      plainEl.innerHTML = (derived.plainLines || []).map(function (l) {
        return "<div class=\"plain-row\"><span class=\"plain-label\">" + escapeHtml(l.label) + "</span><span class=\"plain-value\">" + escapeHtml(l.value) + "</span></div>";
      }).join("");
    }
    summaryEl.innerHTML = (derived.lines || []).map(function (l) {
      return "<dt>" + escapeHtml(l.label) + "</dt><dd>" + escapeHtml(l.value) + "</dd>";
    }).join("");
    if (derived.warnings && derived.warnings.length) {
      warnEl.hidden = false;
      warnEl.textContent = derived.warnings.join(" ");
    } else {
      warnEl.hidden = true;
    }
    if (derived.primaryAction) approveBtn.textContent = derived.primaryAction;
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
        status("Building transaction…");
        return import("/sign/l1-build.js").then(function (mod) {
          l1Mod = mod;
          var p =
            session.kind === "l1-fund"
              ? mod.buildFundTx(session.l1Build)
              : mod.buildSpendTx(session.l1Build);
          return p.then(function (b) {
            built = b;
            var json = b.signedSafeJson || b.safeJson;
            var derived = mod.summarizeBuiltSafeJson(json, {
              kind: session.kind,
              title: undefined,
              networkLabel: session.networkLabel,
              isMainnet: session.isMainnet,
              contractName: session.meta && session.meta.contractName,
              templateId: session.meta && session.meta.templateId,
              p2shAddress: b.p2shAddress || (session.meta && session.meta.p2shAddress),
              entryName: session.l1Build.entryName || (session.meta && session.meta.entry),
            });
            renderSummary(derived);
            connectBtn.disabled = false;
            // One-tap path: enable Approve when wallet already injected
            if (detectL1()) approveBtn.disabled = false;
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
      if (detectL1()) approveBtn.disabled = false;
    });
  }

  function resolveXonly() {
    if (!window.kasware || typeof window.kasware.getPublicKey !== "function") {
      return Promise.reject(new Error("KasWare getPublicKey unavailable"));
    }
    return window.kasware.getPublicKey().then(function (pk) {
      return l1Mod.toXOnlyHex(pk);
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

  function approveL1SpendKasware() {
    // One KasWare approval: signPskt (real sighash) → wrap unlock → pushTx
    var json = built.safeJson;
    if (!json) return Promise.reject(new Error("Missing SafeJSON — build failed"));
    var opts = { signInputs: built.signInputs || [{ index: 0, sighashType: 1 }] };
    status("Approve signature in KasWare…");
    return window.kasware.requestAccounts().then(function () {
      return window.kasware.signPskt({ txJsonString: json, options: opts });
    }).then(function (partial) {
      status("Wrapping covenant unlock…");
      return resolveXonly().then(function (xonly) {
        return l1Mod.finalizeCovenantSpend(session.l1Build, partial, { xonlyPubkeyHex: xonly });
      });
    }).then(function (finalized) {
      built.signedSafeJson = finalized.signedSafeJson;
      status("Broadcasting…");
      return window.kasware.pushTx(finalized.signedSafeJson);
    });
  }

  function approveL1() {
    var w = detectL1();
    if (!w) return Promise.reject(new Error("No L1 wallet"));

    // Already fully unlocked (rare)
    if (built && built.signedSafeJson && built.mode === "signed_ready_for_pushTx") {
      if (w.api === "kasware") return window.kasware.pushTx(built.signedSafeJson);
    }

    // Spend: KasWare signPskt → finalize unlock → pushTx
    if (session.kind === "l1-spend" && session.l1Build && w.api === "kasware") {
      return approveL1SpendKasware();
    }

    var signed = built && built.signedSafeJson;
    if (signed && session.kind !== "l1-spend") {
      if (w.api === "kasware") return window.kasware.pushTx(signed);
    }

    var json = built && built.safeJson;
    if (!json) return Promise.reject(new Error("Missing SafeJSON — build failed"));
    if (w.api === "kasware") {
      var opts =
        built.signInputs && built.signInputs.length ? { signInputs: built.signInputs } : undefined;
      return window.kasware.requestAccounts().then(function () {
        return window.kasware.signPskt({ txJsonString: json, options: opts });
      }).then(function (s) {
        return window.kasware.pushTx(s);
      });
    }
    // Kastle: prefer signAndBroadcastTx; covenant unlock wrapping not implemented for Kastle yet
    if (session.kind === "l1-spend") {
      return Promise.reject(
        new Error(
          "Kastle one-tap SilverScript spend not wired — use KasWare (signPskt → unlock wrap → pushTx)",
        ),
      );
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
