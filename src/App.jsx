import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";

let audioCh = null;

async function getAudioChannel() {
  if (audioCh) return audioCh;

  audioCh = supabase.channel("lojinha-audio", {
    config: { broadcast: { self: false } },
  });

  // garante SUBSCRIBED
  await new Promise((resolve) => {
    audioCh.subscribe((status) => {
      if (status === "SUBSCRIBED") resolve();
    });
  });

  return audioCh;
}

const PRICES = {
  DOCE_SALGADINHO: 2,
  RED_BULL: 7,
  CAPSULA_CAFE: 1.5,
};

function brl(n) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n || 0));
}

function formatItem(item) {
  switch (item) {
    case "RED_BULL":
      return "Red Bull";
    case "CAPSULA_CAFE":
      return "Cápsula de Café";
    default:
      return "Doce/Salgadinho";
  }
}

function monthRangeISO(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function downloadCSV(filename, rows) {
  const SEP = ";";
  const BOM = "\ufeff";
  const csv = rows
    .map((r) =>
      r
        .map((v) => {
          const s = String(v ?? "");
          if (s.includes(SEP) || s.includes('"') || s.includes("\n")) return `"${s.replaceAll('"', '""')}"`;
          return s;
        })
        .join(SEP)
    )
    .join("\n");

  const blob = new Blob([BOM + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* =========================
   MODO BALCÃO (POS)
========================= */
function KioskPOS() {
  // precisa estar logado (tablet com conta ADM fixa)
  const [session, setSession] = useState(null);
  const [msg, setMsg] = useState("");

  const [employees, setEmployees] = useState([]);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null);

  const [item, setItem] = useState("DOCE_SALGADINHO");
  const [qty, setQty] = useState(1);

  const totalNow = useMemo(() => Number(PRICES[item] || 0) * Math.max(1, Number(qty || 1)), [item, qty]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  async function loadEmployees() {
    setMsg("");
    const { data, error } = await supabase
      .from("employees")
      .select("id,user_id,name,sector,company,credit_balance,active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) return setMsg(error.message);
    setEmployees(data ?? []);
  }

  useEffect(() => {
    if (!session?.user?.id) return;
    loadEmployees();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return employees.slice(0, 30);
    return employees
      .filter((e) => {
        const hay = `${e.name} ${e.sector} ${e.company}`.toLowerCase();
        return hay.includes(s);
      })
      .slice(0, 30);
  }, [q, employees]);

  async function confirmKioskPurchase() {
    setMsg("");
    if (!selected?.user_id) return setMsg("Selecione uma pessoa.");
    const safeQty = Math.max(1, Number(qty || 1));

    // registra compra no banco via RPC (admin-only)
    const { error } = await supabase.rpc("kiosk_add_purchase", {
      p_user: selected.user_id,
      p_item: item,
      p_qty: safeQty,
    });

    if (error) return setMsg(error.message);

    // aviso sonoro do balcão (opcional: no seu celular do balcão mesmo)
    try {
      const audio = new Audio("/confirm.mp3");
      audio.volume = 1.0;
      audio.play().catch(() => {});
    } catch {}

    // broadcast para modo balcão/alto-falante (se você quiser manter um segundo device só pro som)
    try {
      const ch = await getAudioChannel();
      await ch.send({
        type: "broadcast",
        event: "purchase_registered",
        payload: {
          name: selected?.name || "Alguém",
          sector: selected?.sector || "",
          company: selected?.company || "",
          item: formatItem(item),
          qty: safeQty,
          total: Number(PRICES[item]) * safeQty,
        },
      });
    } catch {}

    setQty(1);
    setMsg(`Compra registrada ✅ (${selected.name} • ${formatItem(item)} x${safeQty} • ${brl(totalNow)})`);
  }

  // Se não tem sessão, reaproveita sua tela normal de login do app (magic link)
  if (!session) {
    return (
      <div className="page">
        <div className="authCard" style={{ textAlign: "center" }}>
          <div className="brandTitle">🧾 Modo Balcão</div>
          <div className="brandSubtitle">Faça login (conta ADM) para registrar compras no balcão</div>
          <div className="divider" />
          <div style={{ opacity: 0.8, fontSize: 13 }}>
            Abra o app normal e faça login. Depois volte aqui.
            <br />
            (ou deixe o tablet sempre logado)
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="container">
        <div className="topbar">
          <h2 style={{ marginRight: "auto" }}>🧾 Lojinha BF — Balcão</h2>
          <div className="badge">{session.user.email} • KIOSK</div>
          <button className="btnGhost" onClick={signOut}>Sair</button>
        </div>

        {msg && <div className="msg" style={{ marginBottom: 10 }}>{msg}</div>}

        <div className="grid">
          <div className="card">
            <h3 className="cardTitle">👤 Selecionar pessoa</h3>

            <label className="label">Buscar (nome / setor / empresa)</label>
            <input
              className="input"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ex: Gabriel, Logística, FA..."
            />

            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {filtered.map((e) => (
                <button
                  key={e.user_id}
                  className="btnGhost"
                  onClick={() => setSelected(e)}
                  style={{
                    textAlign: "left",
                    border: selected?.user_id === e.user_id ? "1px solid rgba(255,255,255,0.35)" : undefined,
                  }}
                >
                  <div style={{ fontWeight: 700 }}>{e.name}</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    {e.sector} • {e.company} • Crédito: <b>{brl(e.credit_balance || 0)}</b>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && <div style={{ opacity: 0.7 }}>Nenhum resultado.</div>}
            </div>
          </div>

          <div className="card">
            <h3 className="cardTitle">🛒 Registrar compra</h3>

            <div style={{ opacity: 0.85, marginBottom: 10 }}>
              Selecionado:{" "}
              <b>{selected ? `${selected.name} (${selected.sector} / ${selected.company})` : "—"}</b>
            </div>

            <div className="purchaseGrid">
              <label style={{ display: "grid", gap: 6 }}>
                <span>Item</span>
                <select value={item} onChange={(e) => setItem(e.target.value)}>
                  <option value="DOCE_SALGADINHO">Doce/Salgadinho (R$ 2,00)</option>
                  <option value="CAPSULA_CAFE">Cápsula de Café (R$ 1,50)</option>
                  <option value="RED_BULL">Red Bull (R$ 7,00)</option>
                </select>
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span>Qtd</span>
                <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} />
              </label>

              <label style={{ display: "grid", gap: 6 }}>
                <span>Total</span>
                <input value={brl(totalNow)} disabled />
              </label>
            </div>

            <button className="btnPrimary" onClick={confirmKioskPurchase} style={{ marginTop: 12 }}>
              Confirmar compra
            </button>

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
              Dica: deixe este tablet em tela cheia com a URL <b>?kiosk=1</b>.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* =========================
   APP NORMAL (somente extrato)
========================= */
export default function App() {
  const params = new URLSearchParams(window.location.search);
  const isKiosk = params.get("kiosk") === "1";
  if (isKiosk) return <KioskPOS />;

  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  const [profile, setProfile] = useState(null);
  const [myEmployee, setMyEmployee] = useState(null);

  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [fullName, setFullName] = useState("");
  const [sector, setSector] = useState("");
  const [company, setCompany] = useState("");

  const [myPurchases, setMyPurchases] = useState([]);

  const monthSum = useMemo(() => myPurchases.reduce((acc, p) => acc + (p.total || 0), 0), [myPurchases]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  async function sendMagicLink(e) {
    e.preventDefault();
    setMsg("");
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) return setMsg(error.message);
    setMsg("Link de acesso enviado para seu e-mail 📩");
  }

  async function signOut() {
    await supabase.auth.signOut();
    window.location.reload();
  }

  async function loadProfile() {
    const { data, error } = await supabase
      .from("profiles")
      .select("user_id, employee_id, is_admin")
      .single();
    if (error) throw error;
    setProfile(data);
    return data;
  }

  async function loadMyEmployeeByUser(userId) {
    const { data, error } = await supabase
      .from("employees")
      .select("id, name, sector, company, credit_balance, active")
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throw error;
    setMyEmployee(data ?? null);
    return data ?? null;
  }

  async function ensureOnboarding() {
    const userId = session?.user?.id;
    if (!userId) return;

    const emp = await loadMyEmployeeByUser(userId);
    if (!emp) {
      setNeedsOnboarding(true);
      return;
    }

    const prof = await loadProfile();
    if (!prof.employee_id) {
      await supabase.from("profiles").update({ employee_id: emp.id }).eq("user_id", userId);
      const updated = await loadProfile();
      setProfile(updated);
    }
    setNeedsOnboarding(false);
  }

  async function loadMyPurchasesThisMonth() {
    const { start, end } = monthRangeISO(new Date());
    const { data, error } = await supabase
      .from("purchases")
      .select("id, item, qty, total, created_at")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setMyPurchases(data ?? []);
  }

  // EXPORT ADMIN (o seu atual)
  async function exportCSV(companyFilter) {
    setMsg("");

    const { data: s } = await supabase.auth.getSession();
    if (!s?.session) return alert("Sessão expirada.");

    const { data: emps, error: e1 } = await supabase
      .from("employees")
      .select("user_id,name,sector,company,active");

    if (e1) return alert("Erro employees: " + e1.message);

    const empMap = new Map(
      (emps || [])
        .filter((x) => x.active !== false)
        .map((x) => [x.user_id, x])
    );

    const { start, end } = monthRangeISO(new Date());
    const { data: pur, error: e2 } = await supabase
      .from("purchases")
      .select("created_at,user_id,item,unit_price,qty,total")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (e2) return alert("Erro purchases: " + e2.message);

    const rowsObj = (pur || []).map((p) => {
      const emp = empMap.get(p.user_id);
      return {
        data: new Date(p.created_at).toLocaleString("pt-BR"),
        empresa: emp?.company ?? "",
        nome: emp?.name ?? "",
        setor: emp?.sector ?? "",
        item: formatItem(p.item),
        qtd: p.qty,
        unit_price: p.unit_price,
        total: p.total,
        user_id: p.user_id,
      };
    });

    const filtered = companyFilter ? rowsObj.filter((r) => r.empresa === companyFilter) : rowsObj;

    // resumo por usuário
    const summaryMap = new Map();
    for (const r of filtered) {
      const key = `${r.user_id}__${r.nome}__${r.setor}__${r.empresa}`;
      const prev = summaryMap.get(key) || 0;
      summaryMap.set(key, prev + Number(r.total || 0));
    }

    const summaryRows = Array.from(summaryMap.entries()).map(([key, sum]) => {
      const [user_id, nome, setor, empresa] = key.split("__");
      return { empresa, nome, setor, total_mes: sum, user_id };
    });
    summaryRows.sort((a, b) => b.total_mes - a.total_mes);

    const rows = [
      ["DETALHADO"],
      ["Data", "Empresa", "Nome", "Setor", "Item", "Qtd", "Preço Unit", "Total", "UserId"],
      ...filtered.map((r) => [r.data, r.empresa, r.nome, r.setor, r.item, r.qtd, r.unit_price, r.total, r.user_id]),
      [],
      ["RESUMO POR USUÁRIO (TOTAL DO MÊS)"],
      ["Empresa", "Nome", "Setor", "Total do mês", "UserId"],
      ...summaryRows.map((s) => [
        s.empresa,
        s.nome,
        s.setor,
        Number(s.total_mes || 0).toFixed(2).replace(".", ","),
        s.user_id,
      ]),
    ];

    downloadCSV(`lojinha_${companyFilter || "GERAL"}_${new Date().toISOString().slice(0, 7)}.csv`, rows);
  }

  useEffect(() => {
    if (!session?.user?.id) return;
    (async () => {
      try {
        setMsg("");
        await ensureOnboarding();
      } catch (e) {
        setMsg(e.message ?? String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  useEffect(() => {
    if (!session?.user?.id) return;
    if (needsOnboarding) return;
    (async () => {
      try {
        await loadMyPurchasesThisMonth();
      } catch (e) {
        setMsg(e.message ?? String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsOnboarding, session?.user?.id]);

  if (!session) {
    return (
      <div className="page">
        <div className="authCard">
          <div className="brandRow">
            <img src="/favicon.ico" alt="BF" className="brandLogo" />
            <div>
              <div className="brandTitle">Lojinha BF</div>
              <div className="brandSubtitle">Controle interno de compras</div>
            </div>
          </div>

          <div className="divider" />

          <form onSubmit={sendMagicLink} className="form">
            <label className="label">E-mail</label>
            <input
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seuemail@emcompre.com.br"
            />
            <button className="btnPrimary" type="submit">Enviar link</button>
            {msg && <div className="msg">{msg}</div>}
          </form>
        </div>
      </div>
    );
  }

  if (needsOnboarding) {
    return (
      <div className="page">
        <div className="authCard">
          <div className="topRow">
            <div>
              <div className="brandTitle">Complete seu cadastro</div>
              <div className="brandSubtitle">Primeiro acesso. Preencha nome, setor e empresa.</div>
            </div>
            <button className="btnGhost" onClick={signOut}>Sair</button>
          </div>

          <div className="divider" />

          <div className="form">
            <label className="label">Nome completo</label>
            <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Seu nome completo" />

            <label className="label">Setor</label>
            <input className="input" value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Seu setor" />

            <label className="label">Empresa</label>
            <select className="input" value={company} onChange={(e) => setCompany(e.target.value)}>
              <option value="">Selecione...</option>
              <option value="FA">F.A</option>
              <option value="BF">BF Colchões</option>
            </select>

            <button
              className="btnPrimary"
              onClick={async () => {
                setMsg("");
                if (!fullName.trim() || !sector.trim() || !company) return setMsg("Preencha nome, setor e empresa.");

                const userId = session.user.id;

                const { data, error } = await supabase
                  .from("employees")
                  .insert([{ user_id: userId, name: fullName.trim(), sector: sector.trim(), company, active: true }])
                  .select("id")
                  .single();

                if (error) return setMsg(error.message);

                const { error: e2 } = await supabase.from("profiles").update({ employee_id: data.id }).eq("user_id", userId);
                if (e2) return setMsg(e2.message);

                setNeedsOnboarding(false);
                await loadProfile();
                await loadMyEmployeeByUser(userId);
              }}
            >
              Salvar cadastro
            </button>

            {msg && <div className="msg">{msg}</div>}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="container">
        <div className="topbar">
          <h2 style={{ marginRight: "auto" }}>🍫 Lojinha BF</h2>

          <div className="badge">
            {session.user.email}
            {myEmployee ? ` • ${myEmployee.name} (${myEmployee.sector} / ${myEmployee.company})` : ""}
            {profile?.is_admin ? " • ADM" : ""}
            {" • "}
            Crédito: <b>{brl(myEmployee?.credit_balance || 0)}</b>
          </div>

          <button className="btnGhost" onClick={signOut}>Sair</button>
        </div>

        {msg && <p>{msg}</p>}

        <div className="grid">
          {/* ✅ Aviso: compra só no balcão */}
          <div className="card">
            <h3 className="cardTitle">ℹ️ Compras</h3>
            <div style={{ opacity: 0.85 }}>
              As compras são registradas no <b>tablet do balcão</b>.
              <br />
              Aqui no app você acompanha seu extrato, gasto do mês e crédito.
            </div>
          </div>

          {/* Card: Meu gasto do mês */}
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <h3 className="cardTitle" style={{ marginRight: "auto" }}>
                📆 Meu gasto do mês {myEmployee?.name ? `— ${myEmployee.name}` : ""}
              </h3>
              <div className="monoTotal">{brl(monthSum)}</div>
            </div>

            <div className="tableWrap">
              <table>
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Item</th>
                    <th>Qtd</th>
                    <th>Total</th>
                  </tr>
                </thead>
                <tbody>
                  {myPurchases.map((p) => (
                    <tr key={p.id}>
                      <td>{new Date(p.created_at).toLocaleString("pt-BR")}</td>
                      <td>{formatItem(p.item)}</td>
                      <td>{p.qty}</td>
                      <td>{brl(p.total)}</td>
                    </tr>
                  ))}
                  {myPurchases.length === 0 && (
                    <tr>
                      <td colSpan="4" style={{ opacity: 0.7 }}>
                        Sem compras neste mês.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Card: Admin */}
          {profile?.is_admin && (
            <div className="card">
              <h3 className="cardTitle">🛠 Admin</h3>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button onClick={() => exportCSV("FA")}>Exportar CSV F.A (mês)</button>
                <button onClick={() => exportCSV("BF")}>Exportar CSV BF (mês)</button>
                <button onClick={() => exportCSV("")}>Exportar CSV Geral (mês)</button>
              </div>

              <p style={{ opacity: 0.75, marginTop: 10 }}>
                Export mensal = somente compras do mês atual (do dia 1 até o último dia).
              </p>

              <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                URL do balcão: adicione <b>?kiosk=1</b> no final do site.
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
