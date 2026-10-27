import { Children, type ReactNode } from 'react';
import { usePagination } from './usePagination';

export default function PaginatedList({ children, list = false, identity, label }: { children: ReactNode; label?: string; list?: boolean; identity?: string }) {
  const items = Children.toArray(children);
  const key = items.map((item) => typeof item === 'object' && item !== null && 'key' in item ? item.key : String(item)).join('|');
  const { visible, controls } = usePagination(items, identity ?? key, label);
  const Container = list ? 'li' : 'div';
  return <>{visible}{items.length > 0 && <Container className="pagination">{controls}</Container>}</>;
}
