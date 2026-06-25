// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import react from '@astrojs/react';
import yaml from '@modyfi/vite-plugin-yaml';
import mermaid from 'astro-mermaid';

// https://astro.build/config
export default defineConfig({
	integrations: [
		mermaid(),
		starlight({
			title: "Développement coté serveur",
			defaultLocale: "root",
			locales: {
				root: {
					label: 'Français',
					lang: 'fr',
				}
			},
			customCss: [
				'./src/styles/custom.css',
				'./src/styles/global.css',
			],
			lastUpdated: true,
			sidebar: [
				{
					label: 'Notes de cours',
					items: [
						{ label: 'Introduction', slug: 'cours/01-introduction' },
						{ label: 'Prise en main des bases de PHP', slug: 'cours/02-prog-base-php' },
						{ label: 'Notions avancées de PHP', slug: 'cours/03-prog-avancee-php' },
						{ label: 'Navigation et composition de pages', slug: 'cours/04-navigation' },
						{ label: 'Formulaires et GET / POST', slug: 'cours/05-formulaires' },
					]
				},
				{
					label: 'Exercices',
					items: [
						{ label: 'Premiers pas avec PHP', slug: 'exercices/01-introduction' },
						{ label: 'Les fonctions en PHP', slug: 'exercices/02-fonctions' },
						{ label: 'La navigation en PHP', slug: 'exercices/03-navigation' },
					]
				},
				{
					label: 'Travaux',
					items: [
						{ label: 'Sélecteur de place', slug: 'tps/01-selecteur-place' },
					]
				},
				{
					label: 'Reference',
					items: [{
						autogenerate: { directory: 'reference' },
					}]
				},
			],
		}),
		react(),
	],
	vite: {
		plugins: [yaml()],
	}
});
