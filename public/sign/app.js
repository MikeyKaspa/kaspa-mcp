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
  var qwMod = null;
  var qwUnlocked = null;
  var useQuickWallet = false;
  var fundPollTimer = null;

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
    if (useQuickWallet && qwUnlocked) return { id: "quick", name: "Quick-start", api: "quick" };
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
      '<p class="help-block"><strong>Quick-start wallet</strong> works on iPhone Safari (Face ID / PIN). ' +
        "Or use <strong>KasWare</strong> / <strong>Kastle</strong> / <strong>Kaspire</strong>. " +
        "Kaspium/KaChat cannot inject into this page — use Quick-start instead.</p>",
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
                : session.kind === "l1-send"
                  ? mod.buildPaymentTx(session.l1Build)
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
              return initQuickWalletUi();
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
      return initQuickWalletUi();
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
    if (session.kind === "l1-fund" || session.kind === "l1-spend" || session.kind === "l1-send") {
      var w = detectL1();
      if (!w) {
        return Promise.reject(
          new Error(
            "Create or unlock the Quick-start wallet on this page, or install KasWare / Kastle / Kaspire.",
          ),
        );
      }
      if (w.api === "quick") {
        status("Quick-start wallet ready: " + (qwUnlocked && qwUnlocked.address ? qwUnlocked.address : ""));
        showWalletCue(false);
        approveBtn.disabled = false;
        return Promise.resolve();
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

    if (w.api === "quick") {
      status("Approve with Quick-start…", "signing");
      return qwMod
        .assertMainnetReady()
        .catch(function (e) {
          if (String(e && e.message) === "BACKUP_REQUIRED") throw new Error("Save your Quick-start backup before mainnet spends");
          throw e;
        })
        .then(function () {
          return qwMod.signPsktLike(json, opts.signInputs);
        })
        .then(function (partial) {
          return approveSpendWithPartial(partial, Promise.resolve(qwMod.xonlyHex()));
        })
        .then(function (finalized) {
          status("Broadcasting…");
          showWalletCue(false);
          return qwMod.submitSigned(finalized.signedSafeJson, session.l1Build.kaspaNetwork);
        });
    }
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
      var scripts = (session.l1Build.p2shInputs && session.l1Build.p2shInputs.length
        ? session.l1Build.p2shInputs.map(function (inp, i) {
            return { inputIndex: i, scriptHex: inp.bytecodeHex || session.l1Build.bytecodeHex, signType: "All" };
          })
        : [{ inputIndex: 0, scriptHex: session.l1Build.bytecodeHex, signType: "All" }]);
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

    if (w.api === "quick") {
      status("Approve with Quick-start…", "signing");
      return qwMod
        .assertMainnetReady()
        .catch(function (e) {
          if (String(e && e.message) === "BACKUP_REQUIRED") throw new Error("Save your Quick-start backup before mainnet use");
          throw e;
        })
        .then(function () {
          return qwMod.signAndPushSafeJson(json, built.signInputs, session.l1Build.kaspaNetwork);
        })
        .then(function (txid) {
          showWalletCue(false);
          return txid;
        });
    }
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
      if (w && w.api === "quick") return qwMod.submitSigned(built.signedSafeJson, session.l1Build && session.l1Build.kaspaNetwork);
      return l1Mod.submitSignedTx(built.signedSafeJson, session.l1Build && session.l1Build.kaspaNetwork);
    }
    if (session.kind === "l1-spend" && session.l1Build) return approveL1Spend();
    if (session.kind === "l1-send" && session.l1Build) return approveL1Fund();
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
    var p = session.kind === "l1-fund" || session.kind === "l1-spend" || session.kind === "l1-send" ? approveL1() : approveEvm();
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


  function $(id) { return document.getElementById(id); }

  function setHidden(el, hid) {
    if (!el) return;
    el.hidden = !!hid;
  }

  function networkOfSession() {
    return (session && session.l1Build && session.l1Build.kaspaNetwork) || (session && session.isMainnet ? "mainnet" : "testnet-10");
  }

  function utxoApiOfSession() {
    return (session && session.l1Build && session.l1Build.utxoApiBase) || (networkOfSession() === "mainnet" ? "https://api.kaspa.org" : "https://api-tn10.kaspa.org");
  }

  function refreshApproveEnabled() {
    if (detectL1()) approveBtn.disabled = false;
  }

  async function initQuickWalletUi() {
    var panel = $("quickWallet");
    if (!panel) return;
    if (!(session && (session.kind === "l1-fund" || session.kind === "l1-spend" || session.kind === "l1-send"))) {
      setHidden(panel, true);
      return;
    }
    setHidden(panel, false);
    if (!qwMod) {
      qwMod = await import("/sign/quick-wallet.js");
    }
    // e2e hook: pre-inject key without IndexedDB
    if (window.__QUICK_WALLET_TEST_KEY__) {
      qwUnlocked = await qwMod.unlockForTest({
        privateKeyHex: window.__QUICK_WALLET_TEST_KEY__,
        network: networkOfSession(),
      });
      useQuickWallet = true;
      await showQwUnlocked();
      refreshApproveEnabled();
      return;
    }
    wireQwButtons();
    var list = await qwMod.listWallets();
    var net = networkOfSession();
    var match = list.filter(function (w) { return w.network === net; });
    if (qwUnlocked && qwUnlocked.network === net) {
      await showQwUnlocked();
      return;
    }
    if (match.length) {
      $("qwStatus").textContent = "Quick-start wallet found on this device — unlock to approve.";
      setHidden($("qwCreate"), true);
      setHidden($("qwUnlock"), false);
      setHidden($("qwPasskeyBtn"), match[0].unlock !== "passkey-prf");
      window.__QW_ID__ = match[0].id;
      if (match[0].unlock === "passkey-prf") setHidden($("qwPasskeyBtn"), false);
    } else {
      $("qwStatus").textContent = "No Quick-start wallet on this device yet.";
      setHidden($("qwCreate"), false);
      setHidden($("qwUnlock"), true);
    }
    if (session.kind === "l1-send") {
      setHidden($("sendPanel"), false);
      if (session.l1Build && session.l1Build.toAddress && $("sendTo")) {
        $("sendTo").value = session.l1Build.toAddress;
      }
      if (session.l1Build && session.l1Build.amountSompi && $("sendAmt") && session.l1Build.amountSompi !== "0") {
        $("sendAmt").value = qwMod.formatKas(session.l1Build.amountSompi);
      }
      updateSendSummary();
    }
  }

  function wireQwButtons() {
    if (window.__QW_WIRED__) return;
    window.__QW_WIRED__ = true;
    $("qwCreateBtn") && $("qwCreateBtn").addEventListener("click", function () {
      createQw().catch(function (e) {
        $("qwStatus").textContent = "Create failed: " + ((e && e.message) || e);
      });
    });
    $("qwUnlockBtn") && $("qwUnlockBtn").addEventListener("click", function () {
      unlockQw(false).catch(function (e) {
        $("qwStatus").textContent = "Unlock failed: " + ((e && e.message) || e);
      });
    });
    $("qwPasskeyBtn") && $("qwPasskeyBtn").addEventListener("click", function () {
      unlockQw(true).catch(function (e) {
        $("qwStatus").textContent = "Passkey unlock failed: " + ((e && e.message) || e);
      });
    });
    $("qwCopy") && $("qwCopy").addEventListener("click", function () {
      if (!qwUnlocked) return;
      navigator.clipboard.writeText(qwUnlocked.address).then(function () {
        $("qwStatus").textContent = "Address copied";
      });
    });
    $("qwExport") && $("qwExport").addEventListener("click", function () {
      exportQw().catch(function (e) {
        $("qwStatus").textContent = "Export failed: " + ((e && e.message) || e);
      });
    });
    $("qwBackupAck") && $("qwBackupAck").addEventListener("change", function () {
      if ($("qwBackupDone")) $("qwBackupDone").disabled = !$("qwBackupAck").checked;
    });
    $("qwBackupDone") && $("qwBackupDone").addEventListener("click", function () {
      qwMod.acknowledgeBackup(qwUnlocked.id).then(function () {
        setHidden($("qwBackup"), true);
        $("qwStatus").textContent = "Backup acknowledged";
      });
    });
    $("qwImportBtn") && $("qwImportBtn").addEventListener("click", function () {
      importQw().catch(function (e) {
        $("qwStatus").textContent = "Import failed: " + ((e && e.message) || e);
      });
    });
    $("sendMax") && $("sendMax").addEventListener("click", function () {
      window.__SEND_MAX__ = true;
      if ($("sendAmt")) $("sendAmt").value = "";
      updateSendSummary();
    });
    $("sendAmt") && $("sendAmt").addEventListener("input", function () {
      window.__SEND_MAX__ = false;
      updateSendSummary();
    });
    $("sendTo") && $("sendTo").addEventListener("input", updateSendSummary);
    $("sendGo") && $("sendGo").addEventListener("click", function () {
      doSendFromPanel().catch(function (e) {
        status("Send failed: " + ((e && e.message) || e), "err");
      });
    });
  }

  async function createQw() {
    var pin = ($("qwPin") && $("qwPin").value) || "";
    $("qwStatus").textContent = "Creating wallet on this device…";
    var created;
    try {
      created = await qwMod.createWallet({
        network: networkOfSession(),
        pin: pin || undefined,
        preferPasskey: true,
      });
    } catch (e) {
      if (String(e && e.message) === "PIN_REQUIRED") {
        throw new Error("Enter a PIN (4+ characters) — passkey PRF was unavailable on this browser");
      }
      throw e;
    }
    qwUnlocked = { id: created.id, network: created.network, address: created.address, xonlyHex: created.xonlyHex };
    useQuickWallet = true;
    if (created.mnemonic) {
      setHidden($("qwBackup"), false);
      $("qwBackupText").textContent = created.mnemonic + "\n\n" + created.notice;
    }
    await showQwUnlocked();
    refreshApproveEnabled();
    // If fund session fromAddress empty / mismatch, rebuild using quick wallet address
    await maybeRebuildWithQwAddress();
  }

  async function unlockQw(passkey) {
    var id = window.__QW_ID__;
    if (!id) throw new Error("No wallet id");
    var opts = passkey ? {} : { pin: ($("qwUnlockPin") && $("qwUnlockPin").value) || "" };
    qwUnlocked = await qwMod.unlockWallet(id, opts);
    useQuickWallet = true;
    await showQwUnlocked();
    refreshApproveEnabled();
    await maybeRebuildWithQwAddress();
  }

  async function exportQw() {
    var bak = await qwMod.exportBackup();
    setHidden($("qwBackup"), false);
    $("qwBackupText").textContent =
      (bak.mnemonic ? "Mnemonic:\n" + bak.mnemonic + "\n\n" : "") +
      "Private key hex:\n" +
      bak.privateKeyHex +
      "\n\n" +
      bak.warning;
  }

  async function importQw() {
    var raw = (($("qwImportText") && $("qwImportText").value) || "").trim();
    var pin = ($("qwImportPin") && $("qwImportPin").value) || "";
    if (!raw) throw new Error("Paste a backup phrase or key");
    var opts = { network: networkOfSession(), pin: pin, preferPasskey: false, forcePin: true };
    if (raw.split(/\s+/).length >= 12) opts.mnemonic = raw;
    else opts.privateKeyHex = raw;
    var created = await qwMod.importWallet(opts);
    qwUnlocked = { id: created.id, network: created.network, address: created.address, xonlyHex: created.xonlyHex };
    useQuickWallet = true;
    await showQwUnlocked();
    refreshApproveEnabled();
  }

  async function showQwUnlocked() {
    setHidden($("qwCreate"), true);
    setHidden($("qwUnlock"), true);
    setHidden($("qwAddressBox"), false);
    $("qwAddress").textContent = qwUnlocked.address;
    $("qwStatus").textContent = "Quick-start unlocked — ready to approve.";
    connectBtn.textContent = "Use Quick-start";
    // QR via same-origin API
    var qr = $("qwQr");
    if (qr) {
      qr.src = "/api/qr.svg?data=" + encodeURIComponent(qwUnlocked.address);
      qr.hidden = false;
    }
    await refreshQwBalance();
    startFundPollIfNeeded();
    if (session.kind === "l1-send") setHidden($("sendPanel"), false);
  }

  async function refreshQwBalance() {
    if (!qwUnlocked || !qwMod) return;
    try {
      var bal = await qwMod.fetchBalanceSompi(qwUnlocked.address, utxoApiOfSession());
      $("qwBal").textContent = "Balance: " + qwMod.formatKas(bal) + " KAS";
      var hint = $("qwFundHint");
      if (bal === 0n) {
        setHidden(hint, false);
        if (networkOfSession() === "testnet-10") {
          hint.innerHTML =
            'Fund with free test KAS: copy address → open <a href="' +
            qwMod.faucetUrl() +
            '" target="_blank" rel="noopener">TN10 faucet</a> → paste → request. This page watches for arrival.';
        } else {
          hint.textContent =
            "Mainnet: send a small amount of KAS to the address above (Quick-start cap 50 KAS). Page watches for arrival.";
        }
      } else {
        setHidden(hint, true);
      }
      return bal;
    } catch (e) {
      $("qwBal").textContent = "Balance check failed";
      return 0n;
    }
  }

  function startFundPollIfNeeded() {
    if (fundPollTimer) clearInterval(fundPollTimer);
    fundPollTimer = setInterval(function () {
      refreshQwBalance().then(function (bal) {
        if (bal && bal > 0n && session && session.l1Build && !session.l1Build.fromAddress) {
          maybeRebuildWithQwAddress();
        }
      });
    }, 4000);
  }

  async function maybeRebuildWithQwAddress() {
    if (!qwUnlocked || !session || !session.l1Build || !l1Mod) return;
    if (session.kind !== "l1-fund" && session.kind !== "l1-send") return;
    // Rebuild using quick-start as fromAddress when missing or different
    var need =
      !session.l1Build.fromAddress ||
      String(session.l1Build.fromAddress).toLowerCase() !== String(qwUnlocked.address).toLowerCase();
    if (!need) return;
    session.l1Build.fromAddress = qwUnlocked.address;
    status("Rebuilding with Quick-start address…");
    try {
      var b =
        session.kind === "l1-send"
          ? await l1Mod.buildPaymentTx(session.l1Build)
          : await l1Mod.buildFundTx(session.l1Build);
      built = b;
      var derived = l1Mod.summarizeBuiltSafeJson(b.safeJson, {
        kind: session.kind,
        networkLabel: session.networkLabel,
        isMainnet: session.isMainnet,
        contractName: session.meta && session.meta.contractName,
        templateId: session.meta && session.meta.templateId,
        p2shAddress: b.p2shAddress,
        destinationAddress:
          session.l1Build.toAddress ||
          session.l1Build.destinationAddress ||
          (session.kind === "l1-fund" ? b.p2shAddress : null),
      });
      renderSummary(derived);
      refreshApproveEnabled();
      status(derived.title || "Ready");
    } catch (e) {
      // Likely no UTXOs yet — keep waiting
      status("Waiting for funds at Quick-start address…", "");
    }
  }

  function updateSendSummary() {
    var box = $("sendSummary");
    if (!box || !qwMod) return;
    try {
      var to = ($("sendTo") && $("sendTo").value) || "";
      var net = networkOfSession();
      if (to) qwMod.assertAddressNetwork(to, net);
      var amtTxt = window.__SEND_MAX__ ? "(max − fee)" : (($("sendAmt") && $("sendAmt").value) || "");
      var amt = window.__SEND_MAX__ ? null : amtTxt ? qwMod.parseKasToSompi(amtTxt) : null;
      box.textContent =
        (to ? "To: " + to + " · " : "") +
        (window.__SEND_MAX__ ? "Amount: MAX (balance minus fee)" : amt != null ? "Amount: " + qwMod.formatKas(amt) + " KAS" : "Enter amount") +
        " · Network: " +
        net;
      box.style.color = "";
    } catch (e) {
      box.textContent = (e && e.message) || String(e);
      box.style.color = "var(--danger)";
    }
  }

  async function doSendFromPanel() {
    if (!qwUnlocked) throw new Error("Unlock Quick-start first");
    var to = ($("sendTo") && $("sendTo").value || "").trim();
    qwMod.assertAddressNetwork(to, networkOfSession());
    status("Sending with Quick-start…", "signing");
    var res = await qwMod.sendPayment({
      network: networkOfSession(),
      utxoApiBase: utxoApiOfSession(),
      toAddress: to,
      amountSompi: window.__SEND_MAX__ ? "0" : String(qwMod.parseKasToSompi($("sendAmt").value)),
      max: !!window.__SEND_MAX__,
    });
    var exp =
      networkOfSession() === "mainnet"
        ? "https://explorer.kaspa.org/txs/" + res.txid
        : "https://tn10.kaspa.stream/transactions/" + res.txid;
    showSuccess(res.txid, exp);
    await refreshQwBalance();
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
