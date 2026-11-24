export const ROLES = ['admin', 'gerente', 'vendedor'] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'user:manage',
  'settings:manage',
  'product:read',
  'product:write',
  'stock:read',
  'stock:entry',
  'stock:adjust',
  'customer:read',
  'customer:write',
  'customer:credit',
  'sale:create',
  'sale:read',
  'sale:cancel',
  'sale:return',
  'cash:open',
  'cash:close',
  'cash:read',
  'cash:movement',
  'cash:manage',
  'debt:receive',
  'debt:reverse',
  'report:read',
  'sync:resolve',
  'integration:read',
  'integration:manage',
  'integration:admin',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/**
 * Fonte única das permissões. O backend verifica; a UI apenas oculta.
 * Desconto NÃO é uma permissão fixa: depende do limite por papel (`role_discount_limits`),
 * configurável pelo administrador.
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: PERMISSIONS,
  gerente: [
    'product:read',
    'product:write',
    'stock:read',
    'stock:entry',
    'stock:adjust',
    'customer:read',
    'customer:write',
    'customer:credit',
    'sale:create',
    'sale:read',
    'sale:cancel',
    'sale:return',
    'cash:open',
    'cash:close',
    'cash:read',
    'cash:movement',
    'cash:manage',
    'debt:receive',
    'debt:reverse',
    'report:read',
    'sync:resolve',
    'integration:read',
    'integration:manage',
  ],
  vendedor: [
    'product:read',
    'stock:read',
    'customer:read',
    'customer:write',
    'sale:create',
    'sale:read',
    'cash:open',
    'cash:close',
    'cash:read',
    'debt:receive',
  ],
};

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
