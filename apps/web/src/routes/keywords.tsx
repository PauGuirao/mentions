import type { Keyword } from '@mentions/core/schemas';
import { keywordKindSchema } from '@mentions/core/schemas';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { QueryError } from '@/components/query-error';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { api } from '@/lib/api';
import { capitalize } from '@/lib/format';
import { useKeywords } from '@/lib/queries';

export const Route = createFileRoute('/keywords')({ component: KeywordsPage });

const KINDS = keywordKindSchema.options;

function KeywordsPage() {
  const queryClient = useQueryClient();
  const keywordsQuery = useKeywords();
  const [addOpen, setAddOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [kind, setKind] = useState<Keyword['kind']>('brand');

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['keywords'] });
    void queryClient.invalidateQueries({ queryKey: ['mentions'] });
  };

  const createMutation = useMutation({
    mutationFn: () => api.createKeyword({ term: term.trim(), kind }),
    onSuccess: (keyword) => {
      toast.success(`Now tracking "${keyword.term}"`);
      setAddOpen(false);
      setTerm('');
      setKind('brand');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to add keyword'),
  });

  const muteMutation = useMutation({
    mutationFn: ({ id, muted }: { id: string; muted: boolean }) => api.setKeywordMuted(id, muted),
    onSuccess: (_, vars) => {
      toast.success(vars.muted ? 'Keyword muted' : 'Keyword unmuted');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to update keyword'),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteKeyword(id),
    onSuccess: () => {
      toast.success('Keyword deleted');
      invalidate();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to delete keyword'),
  });

  const keywords = keywordsQuery.data?.keywords ?? [];

  return (
    <div className="mx-auto max-w-3xl px-8 py-8">
      <PageHeader
        title="Keywords"
        description="Terms the pipeline polls every source for."
        actions={
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger render={<Button size="sm" />}>
              <Plus /> Add keyword
            </DialogTrigger>
            <DialogContent className="sm:max-w-sm">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  if (term.trim().length >= 2) createMutation.mutate();
                }}
              >
                <DialogHeader>
                  <DialogTitle>Add keyword</DialogTitle>
                  <DialogDescription>
                    New mentions of this term start flowing in on the next poll.
                  </DialogDescription>
                </DialogHeader>
                <div className="grid gap-4 py-4">
                  <div className="grid gap-2">
                    <Label htmlFor="term">Term</Label>
                    <Input
                      id="term"
                      placeholder="e.g. your product name"
                      value={term}
                      onChange={(event) => setTerm(event.target.value)}
                      autoFocus
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Kind</Label>
                    <Select
                      items={Object.fromEntries(KINDS.map((k) => [k, capitalize(k)]))}
                      value={kind}
                      onValueChange={(value) => {
                        const parsed = keywordKindSchema.safeParse(value);
                        if (parsed.success) setKind(parsed.data);
                      }}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {capitalize(k)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    type="submit"
                    disabled={term.trim().length < 2 || createMutation.isPending}
                  >
                    {createMutation.isPending ? 'Adding...' : 'Add keyword'}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        }
      />

      {keywordsQuery.isPending ? (
        <Card className="gap-3 p-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </Card>
      ) : keywordsQuery.isError ? (
        <QueryError error={keywordsQuery.error} onRetry={() => void keywordsQuery.refetch()} />
      ) : keywords.length === 0 ? (
        <Card className="items-center gap-2 py-12 text-center">
          <p className="font-medium">No keywords yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Add your product or brand name to start tracking mentions across sources.
          </p>
        </Card>
      ) : (
        <Card className="py-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Term</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-center">Active</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keywords.map((keyword) => (
                <TableRow key={keyword.id}>
                  <TableCell className="font-medium">{keyword.term}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{capitalize(keyword.kind)}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(keyword.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={!keyword.muted}
                      onCheckedChange={(checked) =>
                        muteMutation.mutate({ id: keyword.id, muted: !checked })
                      }
                      aria-label={keyword.muted ? 'Unmute keyword' : 'Mute keyword'}
                    />
                  </TableCell>
                  <TableCell>
                    <AlertDialog>
                      <AlertDialogTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label="Delete keyword" />
                        }
                      >
                        <Trash2 className="text-muted-foreground" />
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete "{keyword.term}"?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This removes the keyword and every mention matched to it for your
                            org. It cannot be undone.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteMutation.mutate(keyword.id)}>
                            Delete keyword
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
