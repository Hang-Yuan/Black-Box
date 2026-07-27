import { useSettingsStore } from '../../stores/settingsStore';

interface UserAvatarProps {
  size: string;
  rounded?: string;
  className?: string;
}

export function UserAvatar({ size, rounded = 'rounded-[10px]', className = '' }: UserAvatarProps) {
  const avatarUrl = useSettingsStore((s) => s.userAvatarUrl);
  const displayName = useSettingsStore((s) => s.userDisplayName);

  const initial = displayName ? displayName[0].toUpperCase() : '';

  return (
    <div className={`${size} ${rounded}
      flex items-center justify-center flex-shrink-0 shadow-md overflow-hidden ${className}
      ${avatarUrl ? 'bg-transparent' : 'bg-accent/80'}`}>
      {avatarUrl ? (
        <img src={avatarUrl} alt="User" className="w-full h-full object-cover" />
      ) : initial ? (
        <span className="text-text-inverse font-semibold select-none" style={{ fontSize: 'inherit' }}>
          {initial}
        </span>
      ) : (
        <svg width="60%" height="60%" viewBox="0 0 16 16" fill="none" stroke="currentColor"
          strokeWidth="1.2" strokeLinecap="round" className="text-text-inverse">
          <circle cx="8" cy="5.5" r="2.5" />
          <path d="M3 14c0-2.76 2.24-5 5-5s5 2.24 5 5" />
        </svg>
      )}
    </div>
  );
}
