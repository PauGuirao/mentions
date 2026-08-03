import { loader } from 'fumadocs-core/source';
import { openapiPlugin } from 'fumadocs-openapi/server';
import { docs } from 'fumadocs-mdx:collections/server';
import { AlertTriangle, BookOpen, Bot, KeyRound, Workflow } from 'lucide-react';

export const source = loader({
  baseUrl: '/',
  source: docs.toFumadocsSource(),
  plugins: [openapiPlugin()],
  icon(icon) {
    if (!icon) return;
    const icons: Record<string, React.ReactNode> = {
      BookOpen: <BookOpen />,
      KeyRound: <KeyRound />,
      Workflow: <Workflow />,
      AlertTriangle: <AlertTriangle />,
      Bot: <Bot />,
    };
    return icons[icon];
  },
});
