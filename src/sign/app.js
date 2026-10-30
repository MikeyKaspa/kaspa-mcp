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

  var session = null;
  var derived = null;

  function load() {
    return fetch("/api/sign/" + id).then(function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error || ("HTTP " + res.status));
        session = body.session;
        derived = body.summary;
        summaryEl.innerHTML = derived.lines.map(function (l) {
          return "<dt>" + escapeHtml(l.label) + "</dt><dd>" + escapeHtml(l.value) + "</dd>";
        }).join("");
        if (derived.warnings && derived.warnings.length) {
          warnEl.hidden = false;
          warnEl.textContent = derived.warnings.join(" ");
        }
        status(derived.title);
        connectBtn.disabled = false;
      });
    });
  }

  function connect() {
    if (!session) return Promise.resolve();
    if (session.kind === "l1-fund" || session.kind === "l1-spend") {
      var w = detectL1();
      if (!w) return Promise.reject(new Error("Install KasWare or open in KasWare/Kastle in-app browser"));
      if (w.api === "kasware") {
        // docs.kasware.xyz Connection API; extension pageProvider.requestAccounts
        return window.kasware.requestAccounts().then(function (accounts) {
          return window.kasware.getNetwork().catch(function () { return ""; }).then(function (net) {
            status("Connected KasWare: " + (accounts[0] || "") + " · " + net);
            approveBtn.disabled = false;
          });
        });
      }
      var p = typeof window.kastle.connect === "function" ? window.kastle.connect() : Promise.resolve();
      return p.then(function () {
        var getAcc = window.kastle.getAccounts || window.kastle.getAccount;
        return getAcc ? getAcc.call(window.kastle) : null;
      }).then(function (acc) {
        status("Connected Kastle: " + JSON.stringify(acc));
        approveBtn.disabled = false;
      });
    }
    if (!window.ethereum) return Promise.reject(new Error("No injected EVM wallet"));
    return window.ethereum.request({ method: "eth_requestAccounts" }).then(function () {
      if (session.evm && session.evm.chainId) {
        var hex = "0x" + Number(session.evm.chainId).toString(16);
        return window.ethereum.request({
          method: "wallet_switchEthereumChain",
          params: [{ chainId: hex }],
        }).catch(function () { /* chain may need adding */ });
      }
    }).then(function () {
      status("Connected EVM wallet");
      approveBtn.disabled = false;
    });
  }

  function approveL1() {
    var w = detectL1();
    if (!w) return Promise.reject(new Error("No L1 wallet"));
    if (session.kind === "l1-spend" && session.signedSafeJson) {
      if (w.api === "kasware") {
        // wallet.ts pushTx: deserializeFromSafeJSON → submit
        return window.kasware.pushTx(session.signedSafeJson);
      }
      if (window.kastle && window.kastle.signAndBroadcastTx) {
        return Promise.resolve(window.kastle.getNetwork ? window.kastle.getNetwork() : session.networkId)
          .then(function (net) { return window.kastle.signAndBroadcastTx(net, session.signedSafeJson); });
      }
      return Promise.reject(new Error("Wallet cannot broadcast pre-signed spend"));
    }
    var json = session.safeJson;
    if (!json) return Promise.reject(new Error("Missing SafeJSON"));
    if (w.api === "kasware") {
      // wallet.ts signPskt → serializeToSafeJSON; then pushTx
      var opts = session.signInputs && session.signInputs.length
        ? { signInputs: session.signInputs }
        : undefined;
      return window.kasware.signPskt({ txJsonString: json, options: opts }).then(function (signed) {
        return window.kasware.pushTx(signed);
      });
    }
    return Promise.resolve(window.kastle.getNetwork ? window.kastle.getNetwork() : "testnet-10")
      .then(function (net) {
        if (typeof window.kastle.signAndBroadcastTx === "function") {
          return window.kastle.signAndBroadcastTx(net, json);
        }
        if (typeof window.kastle.signTx === "function") {
          return window.kastle.signTx(net, json).then(function (signed) {
            if (typeof window.kastle.signAndBroadcastTx === "function") {
              return window.kastle.signAndBroadcastTx(net, signed);
            }
            throw new Error("Kastle signed but no broadcast method");
          });
        }
        throw new Error("Unsupported Kastle API");
      });
  }

  function approveEvm() {
    if (!window.ethereum || !session.evm) return Promise.reject(new Error("No EVM session"));
    var tx = {
      to: session.evm.to || undefined,
      data: session.evm.data,
      value: session.evm.value && session.evm.value !== "0"
        ? "0x" + BigInt(session.evm.value).toString(16)
        : undefined,
      gas: session.evm.gasLimit ? "0x" + BigInt(session.evm.gasLimit).toString(16) : undefined,
      gasPrice: session.evm.gasPrice ? "0x" + BigInt(session.evm.gasPrice).toString(16) : undefined,
    };
    return window.ethereum.request({ method: "eth_sendTransaction", params: [tx] });
  }

  function approve() {
    status("Approve in your wallet…");
    var p = (session.kind === "l1-fund" || session.kind === "l1-spend") ? approveL1() : approveEvm();
    return p.then(function (txid) {
      return fetch("/api/sign/" + id + "/explorer?txid=" + encodeURIComponent(txid))
        .then(function (r) { return r.json(); })
        .then(function (body) {
          var exp = body.url || String(txid);
          status("Submitted");
          resultEl.hidden = false;
          resultEl.innerHTML = "txid: " + escapeHtml(txid) + "<br/><a href=\"" +
            escapeHtml(exp) + "\" target=\"_blank\" rel=\"noopener\">Open explorer</a>";
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
