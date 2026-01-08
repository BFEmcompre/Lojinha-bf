import { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabase";

const PRICES = { DOCE_SALGADINHO: 2, RED_BULL: 7 };

function brl(n) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n || 0));
}

function formatItem(item) {
  return item === "RED_BULL" ? "Red Bull" : "Doce/Salgadinho";
}

function monthRangeISO(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function downloadCSV(filename, rows) {
  // Excel BR costuma separar por ; e às vezes precisa do BOM
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

export default function App() {
  // auth
  const [session, setSession] = useState(null);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState("");

  // profile / employee
  const [profile, setProfile] = useState(null);
  const [myEmployee, setMyEmployee] = useState(null);

  // onboarding (cadastro)
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [fullName, setFullName] = useState("");
  const [sector, setSector] = useState("");

  // compras (usuário)
  const [item, setItem] = useState("DOCE_SALGADINHO");
  const [qty, setQty] = useState(1);
  const [myPurchases, setMyPurchases] = useState([]);

  // admin
  const [adminPurchases, setAdminPurchases] = useState([]);

  const totalNow = useMemo(() => PRICES[item] * Math.max(1, Number(qty || 1)), [item, qty]);
  const monthSum = useMemo(() => myPurchases.reduce((acc, p) => acc + (p.total || 0), 0), [myPurchases]);

  // Auth listener
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

  async function loadMyEmployeeByUser() {
    // procura employee pelo user_id (auto-cadastro)
    const { data, error } = await supabase
      .from("employees")
      .select("id, name, sector, active")
      .eq("user_id", session.user.id)
      .maybeSingle();

    if (error) throw error;
    setMyEmployee(data ?? null);
    return data ?? null;
  }

  async function ensureOnboarding() {
    // se não existe employee para esse user_id, precisa cadastrar
    const emp = await loadMyEmployeeByUser();
    if (!emp) {
      setNeedsOnboarding(true);
      return;
    }

    // se existe, tenta vincular no profile.employee_id automaticamente (caso esteja vazio)
    const prof = await loadProfile();
    if (!prof.employee_id) {
      await supabase.from("profiles").update({ employee_id: emp.id }).eq("user_id", session.user.id);
      const updated = await loadProfile();
      setProfile(updated);
    }
    setNeedsOnboarding(false);
  }

  async function loadMyPurchasesThisMonth() {
    const { start, end } = monthRangeISO(new Date());
    const { data, error } = await supabase
      .from("purchases")
      .select("id, item, unit_price, qty, total, created_at")
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setMyPurchases(data ?? []);
  }

  async function addPurchase() {
    setMsg("");
    const payload = {
      user_id: session.user.id,
      item,
      unit_price: PRICES[item],
      qty: Math.max(1, Number(qty || 1)),
      total: totalNow,
    };
    const { error } = await supabase.from("purchases").insert([payload]);
    if (error) return setMsg(error.message);
    setQty(1);
    await loadMyPurchasesThisMonth();
  }

  // Admin: carregar compras do mês com nome/setor via join (se employee_id estiver preenchido por trigger)
  async function adminLoadPurchasesThisMonth() {
    const { start, end } = monthRangeISO(new Date());
    const { data, error } = await supabase
      .from("purchases")
      .select(
        `id, item, qty, total, created_at,
         employees:employee_id ( name, sector )`
      )
      .gte("created_at", start)
      .lt("created_at", end)
      .order("created_at", { ascending: false });

    if (error) throw error;
    setAdminPurchases(data ?? []);
  }

  // Quando loga: carrega profile e verifica onboarding
  useEffect(() => {
    if (!session?.user?.id) return;
    (async () => {
      try {
        setMsg("");
        await loadProfile();
        await ensureOnboarding();
        // se onboarding não for necessário, carrega compras
        // (se for necessário, vai exibir tela de cadastro)
      } catch (e) {
        setMsg(e.message ?? String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.user?.id]);

  // Quando onboarding terminar, carregar compras
  useEffect(() => {
    if (!session?.user?.id) return;
    if (needsOnboarding) return;
    (async () => {
      try {
        await loadMyPurchasesThisMonth();
        // se for admin, já carrega compras gerais também
        if (profile?.is_admin) await adminLoadPurchasesThisMonth();
      } catch (e) {
        setMsg(e.message ?? String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsOnboarding, session?.user?.id, profile?.is_admin]);

  // --- TELAS ---

  if (!session) {
    return (
      <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 420, margin: "0 auto" }}>
        <h2>🍫 Lojinha BF</h2>
        <p>Entre com seu e-mail para acessar.</p>

        <form onSubmit={sendMagicLink} style={{ display: "grid", gap: 10 }}>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="seuemail@empresa.com" />
          <button type="submit">Enviar link</button>
        </form>

        {msg && <p style={{ marginTop: 12 }}>{msg}</p>}
      </div>
    );
  }

  // Tela de cadastro (aparece no 1º acesso)
  if (needsOnboarding) {
    return (
      <div style={{ fontFamily: "system-ui", padding: 24, maxWidth: 520, margin: "0 auto" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <h2 style={{ marginRight: "auto" }}>📝 Complete seu cadastro</h2>
          <button onClick={signOut}>Sair</button>
        </div>

        <p style={{ opacity: 0.85 }}>
          Primeiro acesso. Preencha seu <b>nome</b> e <b>setor</b> para liberar o uso da lojinha.
        </p>

        <div style={{ display: "grid", gap: 10 }}>
          <input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Seu nome completo" />
          <input value={sector} onChange={(e) => setSector(e.target.value)} placeholder="Seu setor" />

          <button
            onClick={async () => {
              setMsg("");
              if (!fullName.trim() || !sector.trim()) return setMsg("Preencha nome e setor.");

              // cria o employee do próprio usuário
              const { data, error } = await supabase
                .from("employees")
                .insert([{ user_id: session.user.id, name: fullName.trim(), sector: sector.trim(), active: true }])
                .select("id")
                .single();

              if (error) return setMsg(error.message);

              // vincula no profile
              const { error: e2 } = await supabase
                .from("profiles")
                .update({ employee_id: data.id })
                .eq("user_id", session.user.id);

              if (e2) return setMsg(e2.message);

              setNeedsOnboarding(false);
              await loadProfile();
              await loadMyEmployeeByUser();
            }}
          >
            Salvar cadastro
          </button>

          {msg && <p>{msg}</p>}
        </div>
      </div>
    );
  }

  // Tela principal
  return (
    <div
  style={{
    fontFamily: "system-ui",
    padding: 24,
    maxWidth: 1100,
    margin: "0 auto",
    minHeight: "100vh"
  }}
>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <h2 style={{ marginRight: "auto" }}>🍫 Lojinha BF</h2>
        <div style={{ fontSize: 12, opacity: 0.85 }}>
          {session.user.email}
          {myEmployee ? ` • ${myEmployee.name} (${myEmployee.sector})` : ""}
        </div>
        <button onClick={signOut}>Sair</button>
      </div>

      {msg && <p>{msg}</p>}

      <div style={{ display: "grid", gap: 14, marginTop: 14 }}>
        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <h3 style={{ marginTop: 0 }}>🧾 Lançar compra</h3>

          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "1fr 1fr 1fr" }}>
            <label style={{ display: "grid", gap: 6 }}>
              <span>Item</span>
              <select value={item} onChange={(e) => setItem(e.target.value)}>
                <option value="DOCE_SALGADINHO">Doce/Salgadinho (R$2)</option>
                <option value="RED_BULL">Red Bull (R$7)</option>
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

          <button onClick={addPurchase} style={{ marginTop: 12 }}>
            Confirmar
          </button>
        </div>

        <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <h3 style={{ marginTop: 0, marginRight: "auto" }}>📆 Meu gasto do mês</h3>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{brl(monthSum)}</div>
          </div>

          <div style={{ overflowX: "auto" }}>
            <table width="100%" cellPadding="8" style={{ borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th align="left">Data</th>
                  <th align="left">Item</th>
                  <th align="left">Qtd</th>
                  <th align="left">Total</th>
                </tr>
              </thead>
              <tbody>
                {myPurchases.map((p) => (
                  <tr key={p.id} style={{ borderTop: "1px solid #eee" }}>
                    <td>{new Date(p.created_at).toLocaleString()}</td>
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

        {profile?.is_admin && (
          <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
            <h3 style={{ marginTop: 0 }}>🛠 Admin</h3>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                onClick={async () => {
                  await adminLoadPurchasesThisMonth();
                  const rows = [
                    ["data", "nome", "setor", "item", "qtd", "total"],
                    ...(adminPurchases ?? []).map((p) => [
                      new Date(p.created_at).toLocaleString(),
                      p.employees?.name ?? "",
                      p.employees?.sector ?? "",
                      formatItem(p.item),
                      p.qty,
                      p.total,
                    ]),
                  ];
                  downloadCSV(`lojinha_compras_${new Date().toISOString().slice(0, 7)}.csv`, rows);
                }}
              >
                Exportar CSV do mês
              </button>
            </div>

            <p style={{ opacity: 0.75, marginTop: 10 }}>
              Obs: Para aparecer nome/setor no export, o vínculo precisa existir (auto-cadastro faz isso).
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
