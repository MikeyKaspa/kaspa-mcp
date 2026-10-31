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
  var walletHelpBody = document.getElementById("walletHelpBody");
  var walletCueEl = document.getElementById("walletCue");
  var successBannerEl = document.getElementById("successBanner");
  var connectBtn = document.getElementById("connect");
  var approveBtn = document.getElementById("approve");
  var l1Mod = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function status(t, kind) {
    statusEl.textContent = t;
    statusEl.className = "status" + (kind ? " " + kind : "");
    if (kind === "signing") showWalletCue(true);
    else if (kind === "ok" || kind === "err") showWalletCue(false);
  }

  function showWalletCue(on) {
    if (!walletCueEl) return;
    if (on) walletCueEl.classList.add("show");
    else walletCueEl.classList.remove("show");
  }

  function formatKasFromSompi(sompi) {
    try {
      var n = BigInt(sompi);
      var whole = n / 100000000n;
      var frac = (n % 100000000n).toString().padStart(8, "0").replace(/0+$/, "");
      return frac ? whole + "." + frac + " KAS" : whole + " KAS";
    } catch (e) {
      return String(sompi) + " sompi";
    }
  }

  function setPlainRows(rows) {
    if (!plainEl) return;
    plainEl.classList.remove("skeleton");
    plainEl.innerHTML = (rows || [])
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

  function showSkeletonPlain() {
    if (!plainEl) return;
    plainEl.classList.add("skeleton");
    plainEl.innerHTML =
      '<div class="sk w60"></div><div class="sk w85"></div><div class="sk w40"></div>';
  }

  /** Immediate destination + amount from session (before / while building). */
  function showProvisionalPlain(sess) {
    var rows = [];
    var dest =
      (sess.l1Build && sess.l1Build.destinationAddress) ||
      (sess.l1Build && sess.l1Build.expectedP2shAddress) ||
      (sess.meta && (sess.meta.expectedP2shAddress || sess.meta.p2shAddress)) ||
      "";
    var amt = sess.l1Build && sess.l1Build.amountSompi;
    if (dest) rows.push({ label: "Destination", value: dest });
    if (amt != null && amt !== "") rows.push({ label: "Amount", value: formatKasFromSompi(amt) });
    if (sess.networkLabel) rows.push({ label: "Network", value: sess.networkLabel });
    if (rows.length) setPlainRows(rows);
    else showSkeletonPlain();
  }

  function sharePageHref(sess, builtTx) {
    var meta = (sess && sess.meta) || {};
    if (meta.sharePageUrl) return meta.sharePageUrl;
    if (meta.sharePageId) return "/page/" + meta.sharePageId;
    if (meta.pageId) return "/page/" + meta.pageId;
    return null;
  }

  function showSuccess(txid, explorerUrl) {
    showWalletCue(false);
    status("Submitted — check explorer", "ok");
    var share = sharePageHref(session, built);
    var dest =
      (built && built.p2shAddress) ||
      (session && session.meta && session.meta.p2shAddress) ||
      (session && session.l1Build && session.l1Build.destinationAddress) ||
      "";
    var html =
      "<h2>Success</h2>" +
      '<div class="txid">txid: ' +
      escapeHtml(txid) +
      "</div>" +
      '<div class="success-links">' +
      '<a href="' +
      escapeHtml(explorerUrl) +
      '" target="_blank" rel="noopener">Open explorer</a>';
    if (share) {
      html +=
        '<a class="secondary" href="' +
        escapeHtml(share) +
        '" target="_blank" rel="noopener">Share page</a>';
    } else if (dest) {
      html +=
        '<a class="secondary" href="https://tn10.kaspa.stream/addresses/' +
        encodeURIComponent(dest) +
        '" target="_blank" rel="noopener">View destination</a>';
    }
    html += "</div>";
    if (successBannerEl) {
      successBannerEl.innerHTML = html;
      successBannerEl.classList.add("show");
      successBannerEl.hidden = false;
      try {
        successBannerEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (e) {}
    }
    if (resultEl) {
      resultEl.hidden = false;
      resultEl.innerHTML =
        "txid: " +
        escapeHtml(txid) +
        ' · <a href="' +
        escapeHtml(explorerUrl) +
        '" target="_blank" rel="noopener">Open explorer</a>';
    }
    if (approveBtn) approveBtn.disabled = true;
  }

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
    var bodyEl = walletHelpBody || walletHelpEl;
    var lines = [];
    if (found.length) {
      lines.push("<strong>Detected:</strong> " + found.map(function (w) { return escapeHtml(w.name); }).join(", "));
      walletHelpEl.classList.add("detected");
      walletHelpEl.open = false;
      var sum = walletHelpEl.querySelector("summary");
      if (sum) sum.textContent = "Wallet help";
    } else {
      walletHelpEl.classList.remove("detected");
      walletHelpEl.open = true;
      lines.push("<strong>No injected wallet detected</strong> in this browser.");
    }
    lines.push(
      '<p class="help-block"><strong>Kaspium</strong> and <strong>KaChat</strong> (iPhone) cannot sign this page: ' +
        "no dApp browser / WalletConnect / PSKT API. " +
        "Use <strong>KasWare</strong> or <strong>Kastle</strong> on desktop/Android.</p>",
    );
    lines.push(
      '<p class="help-block fine">Full matrix: docs/WALLET_COMPATIBILITY.md. ' +
        "KasWare Telegram Mini App / Kasanova / Tangem / Ledger+KasVault are not verified for this URL.</p>",
    );
    bodyEl.innerHTML = lines.join("");
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
    var rows = derived.plainLines && derived.plainLines.length ? derived.plainLines : null;
    if (!rows && derived.lines) {
      rows = derived.lines.filter(function (l) {
        return /destination|amount|to |fee|network/i.test(l.label);
      });
    }
    if (rows && rows.length) setPlainRows(rows);
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
    showSkeletonPlain();
    return fetchBody().then(function (body) {
      if (body.error) throw new Error(body.error);
      session = body.session;
      if (!session) throw new Error("Unknown or expired sign session");
      showProvisionalPlain(session);
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
                status("No injectable wallet on iOS Safari — see wallet help");
              }
            });
          })
          .catch(function (e) {
            status("Build failed: " + ((e && e.message) || e), "err");
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
      status("Check your wallet popup…", "signing");
      if (w.api === "kasware") {
        return window.kasware.requestAccounts().then(function (accounts) {
          return window.kasware.getNetwork().catch(function () { return ""; }).then(function (net) {
            status("Connected KasWare: " + (accounts[0] || "") + " · " + net);
            showWalletCue(false);
            approveBtn.disabled = false;
          });
        });
      }
      if (w.api === "kastle") {
        var p = typeof window.kastle.connect === "function" ? window.kastle.connect() : Promise.resolve(true);
        return p.then(function () {
          status("Connected Kastle");
          showWalletCue(false);
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
          showWalletCue(false);
          approveBtn.disabled = false;
        });
      }
    }
    if (!window.ethereum) return Promise.reject(new Error("No injected EVM wallet"));
    status("Check your wallet popup…", "signing");
    return window.ethereum.request({ method: "eth_requestAccounts" }).then(function () {
      status("Connected EVM wallet");
      showWalletCue(false);
      approveBtn.disabled = false;
    });
  }

  function kastleNetworkId() {
    var n = session.l1Build && session.l1Build.kaspaNetwork;
    return n || (session.isMainnet ? "mainnet" : "testnet-10");
  }

  function approveSpendWithPartial(partialSafeJson, xonlyPromise) {
    status("Wrapping covenant unlock…");
    showWalletCue(false);
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
      status("Check your wallet popup…", "signing");
      return window.kasware
        .requestAccounts()
        .then(function () {
          status("Approve signature in KasWare…", "signing");
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
      status("Check your wallet popup…", "signing");
      var net = kastleNetworkId();
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
      status("Check your wallet popup…", "signing");
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
      status("Check your wallet popup…", "signing");
      return window.kasware.requestAccounts().then(function () {
        status("Approve in KasWare…", "signing");
        return window.kasware.signPskt({ txJsonString: json, options: opts }).then(function (s) {
          status("Broadcasting…");
          showWalletCue(false);
          return window.kasware.pushTx(s);
        });
      });
    }
    if (w.api === "kastle") {
      status("Check your wallet popup…", "signing");
      return Promise.resolve(window.kastle.signAndBroadcastTx(kastleNetworkId(), json));
    }
    if (w.api === "kaspire") {
      var opts2 = built.signInputs && built.signInputs.length ? { signInputs: built.signInputs } : undefined;
      status("Check your wallet popup…", "signing");
      var sign =
        typeof window.kaspire.signPskt === "function"
          ? window.kaspire.signPskt({ txJsonString: json, options: opts2 })
          : window.kaspire.request({ method: "signPskt", params: { txJsonString: json, options: opts2 } });
      return Promise.resolve(sign).then(function (s) {
        status("Broadcasting…");
        showWalletCue(false);
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
    status("Check your wallet popup…", "signing");
    return window.ethereum.request({ method: "eth_sendTransaction", params: [tx] });
  }

  function approve() {
    status("Check your wallet popup…", "signing");
    var p = session.kind === "l1-fund" || session.kind === "l1-spend" ? approveL1() : approveEvm();
    return p.then(function (txid) {
      return fetch("/api/sign/" + id + "/explorer?txid=" + encodeURIComponent(txid))
        .then(function (r) {
          return r.json();
        })
        .then(function (body) {
          var exp = body.url || String(txid);
          showSuccess(txid, exp);
        });
    });
  }

  connectBtn.addEventListener("click", function () {
    connect().catch(function (e) {
      showWalletCue(false);
      status("Connect failed: " + ((e && e.message) || e), "err");
    });
  });
  approveBtn.addEventListener("click", function () {
    approve().catch(function (e) {
      showWalletCue(false);
      status("Approve failed: " + ((e && e.message) || e), "err");
    });
  });
  load().catch(function (e) {
    status("Load failed: " + ((e && e.message) || e), "err");
    renderWalletHelp();
  });
})();
