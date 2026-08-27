import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { 
  LayoutDashboard, 
  PlusCircle, 
  History, 
  CheckSquare, 
  Settings, 
  LogOut,
  Sparkles,
  User,
  Radio
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export const Sidebar = () => {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  const navItems = [
    { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { to: '/upload', label: 'New Meeting', icon: PlusCircle, highlight: true },
    { to: '/live', label: 'Google Meet Live', icon: Radio, isLive: true },
    { to: '/history', label: 'Past Meetings', icon: History },
    { to: '/action-items', label: 'Action Items', icon: CheckSquare },
    { to: '/settings', label: 'Settings', icon: Settings },
  ];


  const handleLogout = async () => {
    try {
      await signOut();
      navigate('/login');
    } catch (err) {
      console.error('Logout error:', err);
    }
  };

  return (
    <aside className="w-64 bg-white border-r border-slate-200/80 flex flex-col h-screen sticky top-0 shrink-0 z-30 select-none">
      {/* Brand Header */}
      <div className="p-6 pb-4 border-b border-slate-100 flex items-center gap-3">
        <div className="w-10 h-10 rounded-2xl bg-indigo-600 flex items-center justify-center text-white shadow-md shadow-indigo-200">
          <Sparkles className="w-5 h-5" />
        </div>
        <div>
          <h1 className="text-base font-bold text-slate-900 tracking-tight leading-none">
            Meeting Summarizer
          </h1>
          <span className="text-[11px] font-semibold text-indigo-600 uppercase tracking-wider">
            Gemini AI Intelligence
          </span>
        </div>
      </div>

      {/* Navigation Links */}
      <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `flex items-center justify-between px-3.5 py-2.5 rounded-xl font-medium text-sm transition-all duration-150 ${
                  isActive
                    ? 'bg-indigo-50 text-indigo-700 font-semibold shadow-xs'
                    : item.highlight
                    ? 'text-indigo-600 hover:bg-indigo-50/50'
                    : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                }`
              }
            >
              <div className="flex items-center gap-3">
                <Icon className={`w-4 h-4 shrink-0 ${item.isLive ? 'text-emerald-500' : ''}`} />
                <span>{item.label}</span>
              </div>
              {item.isLive && (
                <span className="flex h-2 w-2 relative">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                </span>
              )}
            </NavLink>

          );
        })}
      </nav>

      {/* User Profile Card & Sign Out */}
      <div className="p-4 border-t border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-3 px-2 py-2 mb-2">
          <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center font-bold text-xs uppercase shrink-0">
            {user?.email?.[0] || 'U'}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-semibold text-slate-800 truncate">
              {user?.user_metadata?.full_name || 'My Account'}
            </p>
            <p className="text-[11px] text-slate-400 truncate">{user?.email}</p>
          </div>
        </div>

        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 rounded-xl transition-colors cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
          <span>Sign Out</span>
        </button>
      </div>
    </aside>
  );
};
