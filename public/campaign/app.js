(function () {
  var id = window.__CAMPAIGN_ID__;
  var meta = window.__CAMPAIGN_META__ || {};
  var status = window.__CAMPAIGN_BOOT__;
  var badge = document.getElementById("statusBadge");
  var raisedLabel = document.getElementById("raisedLabel");
  var goalLabel = document.getElementById("goalLabel");
  var barFill = document.getElementById("barFill");
  var pctLabel = document.getElementById("pctLabel");
  var countdown = document.getElementById("countdown");
  var networkLabel = document.getElementById("networkLabel");
  var pledgeList = document.getElementById("pledgeList");
  var pledgeCount = document.getElementById("pledgeCount");
  var amtInput = document.getElementById("amt");
  var btnPledge = document.getElementById("btnPledge");
  var btnReclaim = document.getElementById("btnReclaim");
  var pledgeStatus = document.getElementById("pledgeStatus");
  var walletCue = document.getElementById("walletCue");
  var connectedAddress = null;
  var tickTimer = null;

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function setStatus(msg, kind) {
    pledgeStatus.textContent = msg || "";
    pledgeStatus.className = "statusline" + (kind ? " " + kind : "");
  }

  function showCue(on) {
    if (!walletCue) return;
    if (on) walletCue.classList.add("show");
    else walletCue.classList.remove("show");
  }

  function detectWallet() {
    if (window.kasware) return { api: "kasware", name: "KasWare" };
    if (window.kastle) return { api: "kastle", name: "Kastle" };
    if (window.kaspire) return { api: "kaspire", name: "Kaspire" };
    return null;
  }

  function formatCountdown(sec) {
    if (sec == null) return "Deadline passed";
    var d = Math.floor(sec / 86400);
    var h = Math.floor((sec % 86400) / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    if (d > 0) return d + "d " + h + "h left";
    if (h > 0) return h + "h " + m + "m left";
    return m + "m " + s + "s left";
  }

  function render(st) {
    if (!st) return;
    status = st;
    badge.textContent = st.statusLabel || st.status;
    badge.className = "badge " + (st.status || "");
    networkLabel.textContent = st.networkId || meta.networkId || "";
    var unit = meta.unit || "KAS";
    raisedLabel.textContent = st.raisedKas + " " + unit;
    goalLabel.textContent = "goal " + st.goalKas + " " + unit;
    barFill.style.width = Math.min(100, st.progressPct || 0) + "%";
    pctLabel.textContent = (Math.round((st.progressPct || 0) * 10) / 10) + "% funded";
    countdown.textContent = formatCountdown(st.secondsRemaining);
    pledgeCount.textContent = (st.pledgeCount || 0) + " backer" + (st.pledgeCount === 1 ? "" : "s");
    var list = st.pledges || [];
    if (!list.length) {
      pledgeList.innerHTML = '<p class="muted">No pledges yet — be the first.</p>';
    } else {
      pledgeList.innerHTML = list
        .map(function (p) {
          var amt = p.hasUtxo ? p.amountKas + " " + unit : "0 " + unit;
          var when = p.time ? new Date(p.time).toLocaleString() : "";
          var link = p.explorerUrl
            ? '<a href="' + escapeHtml(p.explorerUrl) + '" target="_blank" rel="noopener">explorer</a>'
            : "";
          return (
            '<div class="pledge">' +
            '<div class="row"><strong>' +
            escapeHtml(amt) +
            "</strong><span class=\"mono\">" +
            escapeHtml(p.backerShort) +
            "</span></div>" +
            '<div class="row muted"><span>' +
            escapeHtml(when) +
            "</span>" +
            link +
            "</div></div>"
          );
        })
        .join("");
    }
    // Reclaim visible after deadline if this wallet has a pledge with UTXO
    var showReclaim = false;
    if (connectedAddress && st.status === "refunding") {
      for (var i = 0; i < list.length; i++) {
        if (
          list[i].backerAddress === connectedAddress &&
          list[i].hasUtxo
        ) {
          showReclaim = true;
          break;
        }
      }
    }
    btnReclaim.hidden = !showReclaim;
  }

  function refresh() {
    return fetch("/api/campaign/" + id)
      .then(function (r) {
        return r.json();
      })
      .then(function (body) {
        if (body.error) throw new Error(body.error);
        render(body);
        return body;
      });
  }

  function tickCountdown() {
    if (!status) return;
    if (status.secondsRemaining == null) {
      countdown.textContent = "Deadline passed";
      return;
    }
    var left = Math.max(0, Math.floor((Number(status.deadlineMs) - Date.now()) / 1000));
    status.secondsRemaining = left;
    countdown.textContent = formatCountdown(left);
  }

  function connectWallet() {
    var w = detectWallet();
    if (!w) {
      return Promise.reject(
        new Error("Install KasWare, Kastle, or Kaspire (or open in their browser)"),
      );
    }
    showCue(true);
    setStatus("Connecting " + w.name + "…");
    if (w.api === "kasware") {
      return window.kasware.requestAccounts().then(function (accounts) {
        connectedAddress = accounts && accounts[0];
        showCue(false);
        setStatus("Connected: " + connectedAddress, "ok");
        return connectedAddress;
      });
    }
    if (w.api === "kastle") {
      var p = typeof window.kastle.connect === "function" ? window.kastle.connect() : Promise.resolve(true);
      return p.then(function () {
        if (typeof window.kastle.getAccounts === "function") {
          return Promise.resolve(window.kastle.getAccounts()).then(function (accounts) {
            connectedAddress = (accounts && accounts[0]) || null;
            showCue(false);
            setStatus(connectedAddress ? "Connected: " + connectedAddress : "Connected Kastle", "ok");
            return connectedAddress;
          });
        }
        showCue(false);
        setStatus("Connected Kastle — enter is not needed; server uses address from wallet on sign page", "ok");
        return null;
      });
    }
    if (w.api === "kaspire") {
      var kp =
        typeof window.kaspire.requestAccounts === "function"
          ? window.kaspire.requestAccounts()
          : window.kaspire.request({ method: "requestAccounts" });
      return Promise.resolve(kp).then(function (accounts) {
        connectedAddress = accounts && accounts[0];
        showCue(false);
        setStatus("Connected: " + connectedAddress, "ok");
        return connectedAddress;
      });
    }
    return Promise.reject(new Error("Unsupported wallet"));
  }

  function kasToSompi(kas) {
    var n = Number(kas);
    if (!isFinite(n) || n <= 0) throw new Error("Enter a positive amount");
    return String(Math.round(n * 1e8));
  }

  function startPledge() {
    var amountSompi;
    try {
      amountSompi = kasToSompi(amtInput.value);
    } catch (e) {
      setStatus(e.message || String(e), "err");
      return Promise.resolve();
    }
    return connectWallet()
      .then(function (addr) {
        if (!addr) {
          // Kastle without getAccounts — still open sign flow; server needs address
          setStatus("Open the approve page and connect there", "ok");
        }
        showCue(true);
        setStatus("Preparing your pledge…");
        return fetch("/api/campaign/" + id + "/pledge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            backerAddress: addr || undefined,
            amountSompi: amountSompi,
          }),
        });
      })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok || body.error) throw new Error(body.error || "HTTP " + r.status);
          showCue(false);
          if (body.tapToApprove && body.tapToApprove.url) {
            setStatus("Approve in wallet…", "ok");
            window.location.href = body.tapToApprove.url;
            return;
          }
          throw new Error("Missing approve link");
        });
      })
      .catch(function (e) {
        showCue(false);
        setStatus((e && e.message) || String(e), "err");
      });
  }

  function startReclaim() {
    return connectWallet()
      .then(function (addr) {
        if (!addr) throw new Error("Connect a wallet that holds your pledge");
        showCue(true);
        setStatus("Preparing reclaim…");
        return fetch("/api/campaign/" + id + "/reclaim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ backerAddress: addr }),
        });
      })
      .then(function (r) {
        return r.json().then(function (body) {
          if (!r.ok || body.error) throw new Error(body.error || "HTTP " + r.status);
          showCue(false);
          if (body.tapToApprove && body.tapToApprove.url) {
            window.location.href = body.tapToApprove.url;
            return;
          }
          throw new Error("Missing approve link");
        });
      })
      .catch(function (e) {
        showCue(false);
        setStatus((e && e.message) || String(e), "err");
      });
  }

  btnPledge.addEventListener("click", function () {
    startPledge();
  });
  btnReclaim.addEventListener("click", function () {
    startReclaim();
  });

  if (status) render(status);
  refresh()
    .catch(function (e) {
      setStatus("Could not load status: " + ((e && e.message) || e), "err");
    })
    .then(function () {
      tickTimer = setInterval(tickCountdown, 1000);
      setInterval(function () {
        refresh().catch(function () {});
      }, 20000);
    });
})();
