import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Re:Earth Serve" },
    { name: "description", content: "Spatial Data Delivery" },
  ];
}

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-4xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          Re:Earth Serve
        </h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8">
          Spatial Data Delivery
        </p>
      </div>
    </div>
  );
}
