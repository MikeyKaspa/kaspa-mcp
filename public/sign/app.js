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
  var walletHelpEl = document.getElementById("walletHelp");
  var connectBtn = document.getElementById("connect");
  var approveBtn = document.getElementById("approve");
  var l1Mod = null;

  function status(t) { statusEl.textContent = t; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  /** Detect injected Kaspa dApp providers (desktop extensions / Android in-app browsers). */
  function detectWallets() {
    var list = [];
    if (window.kasware) list.push({ id: "kasware", name: "KasWare", api: "kasware" });
    if (window.kastle) list.push({ id: "kastle", name: "Kastle", api: "kastle" });
    if (window.kaspire) list.push({ id: "kaspire", name: "Kaspire", api: "kaspire" });
    return list;
  }
  function detectL1() {
    var w = detectWallets();
    return w[0] || null;
  }

  function isIos() {
    return /iPhone|iPad|iPod/i.test(navigator.userAgent || "");
  }

  function renderWalletHelp() {
    if (!walletHelpEl) return;
    var found = detectWallets();
    var lines = [];
    if (found.length) {
      lines.push("<strong>Detected:</strong> " + found.map(function (w) { return escapeHtml(w.name); }).join(", "));
    } else {
      lines.push("<strong>No injected wallet detected</strong> in this browser.");
    }
    lines.push(
      "<p class=\"help-block\"><strong>Kaspium</strong> and <strong>KaChat</strong> (iPhone) cannot sign this page: " +
        "no dApp browser / WalletConnect / PSKT API (Kaspium GitHub + App Store: native send + text signMessage only; " +
        "KaChat/KaPay: native payments + KasSigner cold-send, not third-party SafeJSON). " +
        "Use <strong>KasWare</strong> or <strong>Kastle</strong> on desktop/Android, or wait for Kastle iOS in-app browser.</p>",
    );
    lines.push(
      '<p class="help-block fine">Full matrix: docs/WALLET_COMPATIBILITY.md on the repo. ' +
        'KasWare Telegram Mini App / Kasanova / Tangem / Ledger+KasVault are not verified for covenant spend from this URL.</p>',
    );
    walletHelpEl.innerHTML = lines.join("");
  }

  function renderSummary(derived) {
    if (headlineEl) headlineEl.textContent = derived.title || "Tap to approve";
    if (badgeEl) {
      badgeEl.hidden = false;
      badgeEl.textContent = derived.networkBadge || (session && session.isMainnet ? "Mainnet" : "Testnet");
      badgeEl.className =
        "badge " +
        ((derived.networkBadge || "").toLowerCase() === "mainnet" || (session && session.isMainnet)
          ? "mainnet"
          : "testnet");
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
      plainEl.innerHTML = (derived.plainLines || [])
        .map(function (l) {
          return (
            '<div class="plain-row"><span class="plain-label">' +
            escapeHtml(l.label) +
            '</span><span class="plain-value">' +
            escapeHtml(l.value) +
            "</span></div>"
          );
        })
        .join("");
    }
    summaryEl.innerHTML = (derived.lines || [])
      .map(function (l) {
        return "<dt>" + escapeHtml(l.label) + "</dt><dd>" + escapeHtml(l.value) + "</dd>";
      })
      .join("");
    if (derived.warnings && derived.warnings.length) {
      warnEl.hidden = false;
      warnEl.textContent = derived.warnings.join(" ");
    } else {
      warnEl.hidden = true;
    }
    if (derived.primaryAction) approveBtn.textContent = derived.primaryAction;
    status(derived.title || "Ready");
    renderWalletHelp();
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
        try {
          body = JSON.parse(text);
        } catch (e) {
          throw new Error("Bad /api/sign response: " + text.slice(0, 80));
        }
        if (!res.ok) throw new Error(body.error || "HTTP " + res.status);
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
        return import("/sign/l1-build.js")
          .then(function (mod) {
            l1Mod = mod;
            var p =
              session.kind === "l1-fund"
                ? mod.buildFundTx(session.l1Build)
                : mod.buildSpendTx(session.l1Build);
            return p.then(function (b) {
              built = b;
              var expected =
                (session.l1Build && session.l1Build.expectedP2shAddress) ||
                (session.meta && (session.meta.expectedP2shAddress || session.meta.p2shAddress)) ||
                "";
              if (
                session.kind === "l1-fund" &&
                expected &&
                b.p2shAddress &&
                String(expected).toLowerCase() !== String(b.p2shAddress).toLowerCase()
              ) {
                throw new Error(
                  "SECURITY: fund destination " +
                    b.p2shAddress +
                    " does not match the contract you were shown (" +
                    expected +
                    "). Do not approve.",
                );
              }
              var json = b.signedSafeJson || b.safeJson;
              var derived = mod.summarizeBuiltSafeJson(json, {
                kind: session.kind,
                networkLabel: session.networkLabel,
                isMainnet: session.isMainnet,
                contractName: session.meta && session.meta.contractName,
                templateId: session.meta && session.meta.templateId,
                p2shAddress: b.p2shAddress || (session.meta && session.meta.p2shAddress),
                entryName: session.l1Build.entryName || (session.meta && session.meta.entry),
                destinationAddress:
                  session.l1Build.destinationAddress ||
                  (session.kind === "l1-fund" ? b.p2shAddress : null),
              });
              renderSummary(derived);
              connectBtn.disabled = false;
              if (detectL1()) approveBtn.disabled = false;
              else if (isIos()) {
                status("No injectable wallet on iOS Safari — see wallet help below");
              }
            });
          })
          .catch(function (e) {
            status("Build failed: " + ((e && e.message) || e));
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
      renderWalletHelp();
    });
  }

  function resolveXonlyKasware() {
    return window.kasware.getPublicKey().then(function (pk) {
      return l1Mod.toXOnlyHex(pk);
    });
  }

  function resolveXonlyKastle() {
    return Promise.resolve(window.kastle.getAccount ? window.kastle.getAccount() : window.kastle.request("kas:get_account")).then(
      function (acc) {
        var pk = acc && (acc.publicKey || acc.pubkey);
        if (!pk) throw new Error("Kastle getAccount missing publicKey");
        return l1Mod.toXOnlyHex(pk);
      },
    );
  }

  function resolveXonlyKaspire() {
    var p =
      typeof window.kaspire.getPublicKey === "function"
        ? window.kaspire.getPublicKey()
        : window.kaspire.request({ method: "getPublicKey" });
    return Promise.resolve(p).then(function (pk) {
      return l1Mod.toXOnlyHex(typeof pk === "string" ? pk : pk.publicKey || pk);
    });
  }

  function connect() {
    if (!session) return Promise.resolve();
    if (session.kind === "l1-fund" || session.kind === "l1-spend") {
      var w = detectL1();
      if (!w) {
        return Promise.reject(
          new Error(
            isIos()
              ? "No Kaspa dApp wallet injected. Kaspium/KaChat cannot sign this page. Use KasWare or Kastle on desktop/Android."
              : "Install KasWare, Kastle, or Kaspire extension (or open in their in-app browser)",
          ),
        );
      }
      if (w.api === "kasware") {
        return window.kasware.requestAccounts().then(function (accounts) {
          return window.kasware.getNetwork().catch(function () { return ""; }).then(function (net) {
            status("Connected KasWare: " + (accounts[0] || "") + " · " + net);
            approveBtn.disabled = false;
          });
        });
      }
      if (w.api === "kastle") {
        var p = typeof window.kastle.connect === "function" ? window.kastle.connect() : Promise.resolve(true);
        return p.then(function () {
          status("Connected Kastle");
          approveBtn.disabled = false;
        });
      }
      if (w.api === "kaspire") {
        var kp =
          typeof window.kaspire.requestAccounts === "function"
            ? window.kaspire.requestAccounts()
            : window.kaspire.request({ method: "requestAccounts" });
        return Promise.resolve(kp).then(function (accounts) {
          status("Connected Kaspire: " + ((accounts && accounts[0]) || ""));
          approveBtn.disabled = false;
        });
      }
    }
    if (!window.ethereum) return Promise.reject(new Error("No injected EVM wallet"));
    return window.ethereum.request({ method: "eth_requestAccounts" }).then(function () {
      status("Connected EVM wallet");
      approveBtn.disabled = false;
    });
  }

  function kastleNetworkId() {
    var n = session.l1Build && session.l1Build.kaspaNetwork;
    return n || (session.isMainnet ? "mainnet" : "testnet-10");
  }

  function approveSpendWithPartial(partialSafeJson, xonlyPromise) {
    status("Wrapping covenant unlock…");
    return xonlyPromise.then(function (xonly) {
      return l1Mod.finalizeCovenantSpend(session.l1Build, partialSafeJson, { xonlyPubkeyHex: xonly });
    });
  }

  function approveL1Spend() {
    var w = detectL1();
    if (!w) return Promise.reject(new Error("No L1 wallet"));
    var json = built.safeJson;
    if (!json) return Promise.reject(new Error("Missing SafeJSON"));
    var opts = { signInputs: built.signInputs || [{ index: 0, sighashType: 1 }] };

    if (w.api === "kasware") {
      status("Approve signature in KasWare…");
      return window.kasware
        .requestAccounts()
        .then(function () {
          return window.kasware.signPskt({ txJsonString: json, options: opts });
        })
        .then(function (partial) {
          return approveSpendWithPartial(partial, resolveXonlyKasware());
        })
        .then(function (finalized) {
          status("Broadcasting…");
          return window.kasware.pushTx(finalized.signedSafeJson);
        });
    }

    if (w.api === "kastle") {
      status("Approve signature in Kastle…");
      var net = kastleNetworkId();
      // Custom script path for P2SH (docs); still extract sig and wrap SilverScript args
      var scripts = [{ inputIndex: 0, scriptHex: session.l1Build.bytecodeHex, signType: "All" }];
      return Promise.resolve(window.kastle.signTx(net, json, scripts))
        .then(function (partial) {
          return approveSpendWithPartial(partial, resolveXonlyKastle());
        })
        .then(function (finalized) {
          status("Broadcasting via node…");
          return l1Mod.submitSignedTx(finalized.signedSafeJson, session.l1Build.kaspaNetwork);
        });
    }

    if (w.api === "kaspire") {
      status("Approve signature in Kaspire…");
      var sign =
        typeof window.kaspire.signPskt === "function"
          ? window.kaspire.signPskt({ txJsonString: json, options: opts })
          : window.kaspire.request({
              method: "signPskt",
              params: { txJsonString: json, options: opts },
            });
      return Promise.resolve(sign)
        .then(function (partial) {
          return approveSpendWithPartial(partial, resolveXonlyKaspire());
        })
        .then(function (finalized) {
          status("Broadcasting…");
          if (typeof window.kaspire.pushTx === "function") {
            return window.kaspire.pushTx(finalized.signedSafeJson);
          }
          return l1Mod.submitSignedTx(finalized.signedSafeJson, session.l1Build.kaspaNetwork);
        });
    }

    return Promise.reject(new Error("Unsupported wallet for spend"));
  }

  function approveL1Fund() {
    var w = detectL1();
    if (!w) return Promise.reject(new Error("No L1 wallet"));
    var json = built.safeJson;
    if (!json) return Promise.reject(new Error("Missing SafeJSON"));

    if (w.api === "kasware") {
      var opts = built.signInputs && built.signInputs.length ? { signInputs: built.signInputs } : undefined;
      return window.kasware.requestAccounts().then(function () {
        return window.kasware.signPskt({ txJsonString: json, options: opts }).then(function (s) {
          return window.kasware.pushTx(s);
        });
      });
    }
    if (w.api === "kastle") {
      return Promise.resolve(window.kastle.signAndBroadcastTx(kastleNetworkId(), json));
    }
    if (w.api === "kaspire") {
      var opts2 = built.signInputs && built.signInputs.length ? { signInputs: built.signInputs } : undefined;
      var sign =
        typeof window.kaspire.signPskt === "function"
          ? window.kaspire.signPskt({ txJsonString: json, options: opts2 })
          : window.kaspire.request({ method: "signPskt", params: { txJsonString: json, options: opts2 } });
      return Promise.resolve(sign).then(function (s) {
        if (typeof window.kaspire.pushTx === "function") return window.kaspire.pushTx(s);
        return l1Mod.submitSignedTx(s, session.l1Build.kaspaNetwork);
      });
    }
    return Promise.reject(new Error("Unsupported wallet for fund"));
  }

  function approveL1() {
    if (built && built.signedSafeJson && built.mode === "signed_ready_for_pushTx") {
      var w = detectL1();
      if (w && w.api === "kasware") return window.kasware.pushTx(built.signedSafeJson);
      return l1Mod.submitSignedTx(built.signedSafeJson, session.l1Build && session.l1Build.kaspaNetwork);
    }
    if (session.kind === "l1-spend" && session.l1Build) return approveL1Spend();
    return approveL1Fund();
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
        .then(function (r) {
          return r.json();
        })
        .then(function (body) {
          var exp = body.url || String(txid);
          status("Submitted");
          resultEl.hidden = false;
          resultEl.innerHTML =
            "txid: " +
            escapeHtml(txid) +
            '<br/><a href="' +
            escapeHtml(exp) +
            '" target="_blank" rel="noopener">Open explorer</a>';
        });
    });
  }

  connectBtn.addEventListener("click", function () {
    connect().catch(function (e) {
      status("Connect failed: " + ((e && e.message) || e));
    });
  });
  approveBtn.addEventListener("click", function () {
    approve().catch(function (e) {
      status("Approve failed: " + ((e && e.message) || e));
    });
  });
  load().catch(function (e) {
    status("Load failed: " + ((e && e.message) || e));
    renderWalletHelp();
  });
})();
