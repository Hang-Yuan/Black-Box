import { useId, type CSSProperties } from 'react';
import type { DesktopPetPhase } from '../../lib/desktop-pet';
import type {
  DesktopPetAccessory,
  DesktopPetBody,
  DesktopPetDesign,
  DesktopPetEyes,
  DesktopPetMouth,
} from '../../lib/desktop-pet-presets';
import './PetAvatar.css';

interface PetAvatarProps {
  design: DesktopPetDesign;
  phase?: DesktopPetPhase;
  size?: number;
  className?: string;
  decorative?: boolean;
  animated?: boolean;
}

const PHASE_COLORS: Record<DesktopPetPhase, string> = {
  idle: '#E8D694',
  thinking: '#C7ADFF',
  tool: '#81E2F2',
  running: '#93E8AE',
  waiting: '#FFD47D',
  error: '#FF8F98',
};

function Body({ body, gradientId }: { body: DesktopPetBody; gradientId: string }) {
  switch (body) {
    case 'hourglass':
      return (
        <g className="pet-avatar__hourglass">
          <path className="pet-avatar__line" d="M31 19C44 8 76 8 89 19" />
          <path className="pet-avatar__line" d="M31 101C44 112 76 112 89 101" />
          <path className="pet-avatar__line pet-avatar__line--strong" d="M24 29C38 22 82 22 96 29C103 33 99 40 91 47L38 89C32 94 24 91 28 82C35 69 51 60 66 48C78 39 87 31 82 29" />
          <path className="pet-avatar__line" d="M25 31C21 40 35 48 48 56L87 82C100 91 101 97 93 96C75 94 36 74 26 64C16 53 19 41 25 31" />
          <path className="pet-avatar__grain" d="M58 53L63 58L59 63L55 58Z" />
        </g>
      );
    case 'cat':
      return (
        <g>
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M28 45L31 20L49 34C56 31 64 31 71 34L89 20L92 46C100 54 102 69 97 82C91 98 78 105 60 105C42 105 29 98 23 82C18 68 20 54 28 45Z" />
          <path className="pet-avatar__detail" d="M32 26L44 36M88 26L76 36" />
        </g>
      );
    case 'fox':
      return (
        <g>
          <path className="pet-avatar__tail" fill={`url(#${gradientId})`} d="M88 70C110 67 111 91 95 102C83 110 75 101 84 94C94 87 98 78 88 70Z" />
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M24 43L27 15L49 34C56 31 64 31 71 34L94 15L96 44C101 54 100 70 94 84C87 99 75 105 60 105C45 105 33 99 26 84C20 70 19 54 24 43Z" />
          <path className="pet-avatar__mask" d="M35 69C42 88 51 96 60 97C69 96 78 88 85 69C76 76 68 79 60 79C52 79 44 76 35 69Z" />
        </g>
      );
    case 'rabbit':
      return (
        <g>
          <ellipse className="pet-avatar__body" fill={`url(#${gradientId})`} cx="43" cy="29" rx="12" ry="27" transform="rotate(-8 43 29)" />
          <ellipse className="pet-avatar__body" fill={`url(#${gradientId})`} cx="77" cy="29" rx="12" ry="27" transform="rotate(8 77 29)" />
          <ellipse className="pet-avatar__ear-inner" cx="43" cy="27" rx="5" ry="18" transform="rotate(-8 43 27)" />
          <ellipse className="pet-avatar__ear-inner" cx="77" cy="27" rx="5" ry="18" transform="rotate(8 77 27)" />
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M26 58C26 39 40 30 60 30C80 30 94 39 94 58V76C94 96 80 106 60 106C40 106 26 96 26 76Z" />
        </g>
      );
    case 'bear':
      return (
        <g>
          <circle className="pet-avatar__body" fill={`url(#${gradientId})`} cx="31" cy="38" r="16" />
          <circle className="pet-avatar__body" fill={`url(#${gradientId})`} cx="89" cy="38" r="16" />
          <circle className="pet-avatar__ear-inner" cx="31" cy="38" r="8" />
          <circle className="pet-avatar__ear-inner" cx="89" cy="38" r="8" />
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M23 62C23 40 38 27 60 27C82 27 97 40 97 62V76C97 96 82 106 60 106C38 106 23 96 23 76Z" />
          <ellipse className="pet-avatar__muzzle" cx="60" cy="73" rx="20" ry="15" />
        </g>
      );
    case 'owl':
      return (
        <g>
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M24 48L35 24L51 35C57 32 63 32 69 35L85 24L96 48V77C96 97 81 107 60 107C39 107 24 97 24 77Z" />
          <path className="pet-avatar__wing" d="M29 61C13 68 17 93 37 95M91 61C107 68 103 93 83 95" />
          <circle className="pet-avatar__eye-disc" cx="45" cy="58" r="17" />
          <circle className="pet-avatar__eye-disc" cx="75" cy="58" r="17" />
          <path className="pet-avatar__beak" d="M55 69L60 77L65 69Z" />
        </g>
      );
    case 'robot':
      return (
        <g>
          <path className="pet-avatar__detail" d="M60 28V16" />
          <circle className="pet-avatar__antenna" cx="60" cy="12" r="6" />
          <rect className="pet-avatar__body" fill={`url(#${gradientId})`} x="22" y="30" width="76" height="72" rx="25" />
          <path className="pet-avatar__detail" d="M22 66H14M106 66H98M42 102V109M78 102V109" />
          <rect className="pet-avatar__panel" x="32" y="43" width="56" height="35" rx="13" />
        </g>
      );
    case 'cloud':
      return (
        <g>
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M25 88C12 86 12 63 27 58C27 40 43 29 57 37C67 18 94 29 91 51C111 52 113 79 97 86C87 91 38 92 25 88Z" />
          <path className="pet-avatar__detail" d="M35 95L31 106M60 95V108M85 95L89 106" />
        </g>
      );
    case 'slime':
      return (
        <g>
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M18 92C20 72 28 63 32 47C36 30 45 22 60 22C75 22 84 30 88 47C92 63 100 72 102 92C92 103 31 103 18 92Z" />
          <circle className="pet-avatar__shine" cx="42" cy="42" r="9" />
          <path className="pet-avatar__detail" d="M22 90C29 96 35 97 42 91C49 99 57 99 64 92C72 99 80 98 87 91C93 96 98 95 102 92" />
        </g>
      );
    case 'axolotl':
      return (
        <g>
          <path className="pet-avatar__gill" d="M29 49L14 36M27 58L10 56M30 67L15 79M91 49L106 36M93 58L110 56M90 67L105 79" />
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M20 59C20 37 36 26 60 26C84 26 100 37 100 59V75C100 94 83 105 60 105C37 105 20 94 20 75Z" />
          <path className="pet-avatar__detail" d="M38 91C47 98 73 98 82 91" />
        </g>
      );
    case 'spirit':
      return (
        <g>
          <path className="pet-avatar__body" fill={`url(#${gradientId})`} d="M60 15C82 15 96 32 96 55C96 73 88 85 76 93C69 98 72 108 86 109C73 117 58 112 54 102C47 112 33 113 23 106C36 104 39 96 32 89C25 82 22 70 22 56C22 32 37 15 60 15Z" />
          <path className="pet-avatar__shine" d="M38 33C44 25 51 22 58 22" />
        </g>
      );
  }
}

function Eyes({ eyes }: { eyes: DesktopPetEyes }) {
  switch (eyes) {
    case 'dot':
      return <><circle cx="46" cy="60" r="4" /><circle cx="74" cy="60" r="4" /></>;
    case 'sparkle':
      return <><path d="M46 53V67M39 60H53" /><path d="M74 53V67M67 60H81" /></>;
    case 'sleepy':
      return <><path d="M38 61C43 67 49 67 54 61" /><path d="M66 61C71 67 77 67 82 61" /></>;
    case 'visor':
      return <rect x="36" y="52" width="48" height="15" rx="7.5" />;
    case 'wink':
      return <><circle cx="46" cy="60" r="4" /><path d="M66 61C71 66 77 66 82 60" /></>;
  }
}

function Mouth({ mouth }: { mouth: DesktopPetMouth }) {
  switch (mouth) {
    case 'smile': return <path d="M50 75C55 82 65 82 70 75" />;
    case 'cat': return <path d="M52 76L60 72L68 76M60 72V79" />;
    case 'tiny': return <circle cx="60" cy="77" r="2.5" />;
    case 'flat': return <path d="M53 77H67" />;
    case 'none': return null;
  }
}

function Accessory({ accessory }: { accessory: DesktopPetAccessory }) {
  switch (accessory) {
    case 'none': return null;
    case 'crown': return <path className="pet-avatar__accessory-fill" d="M43 28L46 12L59 24L72 11L78 30Z" />;
    case 'bow': return <g className="pet-avatar__accessory-fill"><path d="M49 34C34 24 31 43 48 43Z" /><path d="M71 34C86 24 89 43 72 43Z" /><circle cx="60" cy="39" r="7" /></g>;
    case 'leaf': return <path className="pet-avatar__accessory-fill" d="M61 28C67 12 84 13 87 12C84 29 72 35 61 28ZM61 28L55 36" />;
    case 'star': return <path className="pet-avatar__accessory-fill" d="M84 24L88 33L98 34L90 41L92 51L84 46L75 51L78 41L70 34L80 33Z" />;
    case 'glasses': return <g className="pet-avatar__accessory-line"><circle cx="45" cy="60" r="12" /><circle cx="75" cy="60" r="12" /><path d="M57 60H63M33 57L25 53M87 57L95 53" /></g>;
    case 'headset': return <g className="pet-avatar__accessory-line"><path d="M29 62V52C29 31 42 22 60 22C78 22 91 31 91 52V62" /><rect x="22" y="56" width="12" height="25" rx="6" /><rect x="86" y="56" width="12" height="25" rx="6" /><path d="M92 78C90 91 81 93 73 93" /></g>;
    case 'scarf': return <g className="pet-avatar__accessory-fill"><path d="M31 83C48 91 72 91 89 83L87 96C71 103 49 103 33 96Z" /><path d="M74 96L91 111L78 113L66 99Z" /></g>;
    case 'antenna': return <g className="pet-avatar__accessory-line"><path d="M60 29V12" /><circle className="pet-avatar__accessory-fill" cx="60" cy="9" r="5" /></g>;
  }
}

export function PetAvatar({
  design,
  phase = 'idle',
  size = 96,
  className = '',
  decorative = true,
  animated = true,
}: PetAvatarProps) {
  const gradientId = `pet-gradient-${useId().replace(/:/g, '')}`;
  const style = {
    width: size,
    height: size,
    '--pet-body': design.bodyColor,
    '--pet-accent': design.accentColor,
    '--pet-phase': PHASE_COLORS[phase],
  } as CSSProperties;

  return (
    <span
      className={`pet-avatar pet-avatar--${design.motion} pet-avatar--${design.scale} ${animated ? '' : 'pet-avatar--still'} ${className}`.trim()}
      data-body={design.body}
      data-phase={phase}
      style={style}
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : design.name}
    >
      <svg className="pet-avatar__canvas" viewBox="0 0 120 120">
        <defs>
          <linearGradient id={gradientId} x1="24" y1="20" x2="98" y2="108" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor={design.accentColor} stopOpacity="0.84" />
            <stop offset="0.38" stopColor={design.bodyColor} />
            <stop offset="1" stopColor={design.bodyColor} stopOpacity="0.82" />
          </linearGradient>
        </defs>
        <g className="pet-avatar__character">
          <Body body={design.body} gradientId={gradientId} />
          {design.body !== 'hourglass' && (
            <g className="pet-avatar__face">
              <g className="pet-avatar__eyes"><Eyes eyes={design.eyes} /></g>
              <g className="pet-avatar__mouth"><Mouth mouth={design.mouth} /></g>
            </g>
          )}
          <Accessory accessory={design.accessory} />
        </g>
        <g className="pet-avatar__orbit" aria-hidden="true">
          <circle cx="60" cy="8" r="3" />
          <circle cx="108" cy="60" r="2.5" />
          <circle cx="18" cy="92" r="2" />
        </g>
        <circle className="pet-avatar__status" cx="102" cy="101" r="7" />
      </svg>
    </span>
  );
}
