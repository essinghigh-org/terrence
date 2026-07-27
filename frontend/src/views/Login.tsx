import { useState } from "react";
import { fetchApi, setAuthToken } from "../lib/api";
import { useNavigate, Link } from "react-router-dom";
import { Button } from "../components/ui/button";

export function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const navigate = useNavigate();

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    try {
      const data = await fetchApi("/users/login", {
        method: "POST",
        body: JSON.stringify({
          data: { attributes: { username, password } }
        })
      });
      setAuthToken(data.data.attributes.token);
      navigate("/app");
    } catch (err) {
      alert("Login failed");
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4 font-sans">
      <div className="max-w-md w-full bg-white rounded-lg shadow-sm border border-gray-200 p-8">
        <div className="text-center mb-8">
          {/* Logo placeholder */}
          <div className="mx-auto w-12 h-12 bg-[#111315] rounded mb-4 flex items-center justify-center">
             <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M12 2L2 7V17L12 22L22 17V7L12 2Z" fill="white" />
              <path d="M12 22V12" stroke="#111315" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M12 12L22 7" stroke="#111315" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 7L12 12" stroke="#111315" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h2 className="text-2xl font-bold text-gray-900 tracking-tight">Sign in to Terrence</h2>
        </div>

        <form onSubmit={handleLogin} noValidate className="space-y-4">
          <div>
            <label htmlFor="username" className="block text-sm font-semibold text-gray-700 mb-1.5">Username</label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onInput={(e: any) => setUsername(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm font-semibold text-gray-700 mb-1.5">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onInput={(e: any) => setPassword(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
            />
          </div>
          <Button type="submit" className="w-full bg-[#2962ff] hover:bg-[#1a4bcf] text-white font-semibold py-2 h-10 shadow-sm">
            Sign in
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-gray-600">
          Don't have an account? <Link to="/register" className="text-blue-600 hover:underline font-medium">Create account</Link>
        </p>
      </div>
    </div>
  );
}
